const db = require("../db");
const { audit } = require("./audit");
const { HttpError } = require("../errors");

// Regras de negócio centralizadas
const RULES = {
  minStakeCents: 100, // R$ 1,00
  maxStakeCents: 1000000, // R$ 10.000,00
  maxSelections: 20,
  maxPayoutCents: 50000000, // R$ 500.000,00 de ganho máximo por bilhete
  closeBeforeStartMs: 60000, // apostas fecham 1 minuto antes do início
};

/** Movimenta saldo de forma atômica e registra no ledger. Usar dentro de transação. */
function adjustBalance(userId, deltaCents, type, ref = null) {
  const row = db
    .prepare("SELECT balance_cents FROM users WHERE id = ?")
    .get(userId);
  if (!row) throw new HttpError(404, "Usuário não encontrado");
  const after = row.balance_cents + deltaCents;
  if (after < 0) throw new HttpError(402, "Saldo insuficiente");
  db.prepare("UPDATE users SET balance_cents = ? WHERE id = ?").run(
    after,
    userId
  );
  db.prepare(
    "INSERT INTO ledger (user_id, amount_cents, balance_after_cents, type, ref) VALUES (?,?,?,?,?)"
  ).run(userId, deltaCents, after, type, ref);
  return after;
}

function getBet(id) {
  const bet = db.prepare("SELECT * FROM bets WHERE id = ?").get(id);
  if (!bet) return null;
  bet.selections = db
    .prepare(
      `
      SELECT bs.match_id, bs.selection, bs.price, bs.status, h.name AS home, a.name AS away
      FROM bet_selections bs
      JOIN matches m ON m.id = bs.match_id
      JOIN teams h ON h.id = m.home_team_id
      JOIN teams a ON a.id = m.away_team_id
      WHERE bs.bet_id = ?`
    )
    .all(id);
  return bet;
}

function placeBet({ userId, stakeCents, selections, ip }) {
  if (
    !Number.isInteger(stakeCents) ||
    stakeCents < RULES.minStakeCents ||
    stakeCents > RULES.maxStakeCents
  ) {
    throw new HttpError(400, "Valor de aposta fora dos limites permitidos");
  }
  if (
    !Array.isArray(selections) ||
    selections.length < 1 ||
    selections.length > RULES.maxSelections
  ) {
    throw new HttpError(
      400,
      `O bilhete deve ter entre 1 e ${RULES.maxSelections} seleções`
    );
  }

  const getOdd = db.prepare(`
    SELECT o.price, o.active, m.status, m.starts_at
    FROM odds o JOIN matches m ON m.id = o.match_id
    WHERE o.match_id = ? AND o.selection = ?`);

  const tx = db.transaction(() => {
    const seen = new Set();
    const rows = [];
    let totalOdds = 1;
    const now = Date.now();

    for (const s of selections) {
      const matchId = Number(s.matchId);
      const sel = s.selection;
      if (!["home", "draw", "away"].includes(sel))
        throw new HttpError(400, "Seleção inválida");
      if (seen.has(matchId))
        throw new HttpError(400, "Apenas uma seleção por partida no bilhete");
      seen.add(matchId);

      const o = getOdd.get(matchId, sel);
      if (!o || !o.active) throw new HttpError(400, "Odd indisponível");
      if (
        o.status !== "scheduled" ||
        Date.parse(o.starts_at) - RULES.closeBeforeStartMs <= now
      ) {
        throw new HttpError(400, "Partida não aceita mais apostas");
      }
      rows.push({ matchId, selection: sel, price: o.price });
      totalOdds *= o.price;
    }

    const potential = Math.floor(stakeCents * totalOdds);
    if (potential > RULES.maxPayoutCents)
      throw new HttpError(400, "Ganho potencial acima do limite");

    const betId = Number(
      db
        .prepare(
          "INSERT INTO bets (user_id, stake_cents, total_odds, potential_cents) VALUES (?,?,?,?)"
        )
        .run(userId, stakeCents, totalOdds, potential).lastInsertRowid
    );

    adjustBalance(userId, -stakeCents, "bet_stake", `bet:${betId}`);

    const ins = db.prepare(
      "INSERT INTO bet_selections (bet_id, match_id, selection, price) VALUES (?,?,?,?)"
    );
    for (const r of rows) ins.run(betId, r.matchId, r.selection, r.price);

    audit({
      actorId: userId,
      action: "bet.place",
      entity: "bet",
      entityId: betId,
      data: { stakeCents, totalOdds, selections: rows },
      ip,
    });
    return betId;
  });

  return getBet(tx());
}

/** Liquida a aposta se todas as seleções já foram decididas (ou se houve perda). */
function settleIfDone(betId, actorId = null, ip = null) {
  const bet = db.prepare("SELECT * FROM bets WHERE id = ?").get(betId);
  if (!bet || bet.status !== "open") return;

  const sels = db
    .prepare("SELECT * FROM bet_selections WHERE bet_id = ?")
    .all(betId);

  if (sels.some((s) => s.status === "lost")) {
    db.prepare(
      "UPDATE bets SET status = 'lost', payout_cents = 0, settled_at = datetime('now') WHERE id = ?"
    ).run(betId);
    audit({
      actorId,
      action: "bet.settle",
      entity: "bet",
      entityId: betId,
      data: { status: "lost" },
      ip,
    });
    return;
  }
  if (sels.some((s) => s.status === "pending")) return;

  const won = sels.filter((s) => s.status === "won");
  let payout;
  let status;
  if (won.length === 0) {
    payout = bet.stake_cents; // todas anuladas: devolve a stake
    status = "void";
  } else {
    const mult = won.reduce((acc, s) => acc * s.price, 1);
    payout = Math.min(Math.floor(bet.stake_cents * mult), RULES.maxPayoutCents);
    status = "won";
  }

  adjustBalance(bet.user_id, payout, "bet_payout", `bet:${betId}`);
  db.prepare(
    "UPDATE bets SET status = ?, payout_cents = ?, settled_at = datetime('now') WHERE id = ?"
  ).run(status, payout, betId);
  audit({
    actorId,
    action: "bet.settle",
    entity: "bet",
    entityId: betId,
    data: { status, payout },
    ip,
  });
}

function setResult(matchId, homeScore, awayScore, actorId, ip) {
  if (
    !Number.isInteger(homeScore) ||
    !Number.isInteger(awayScore) ||
    homeScore < 0 ||
    awayScore < 0
  ) {
    throw new HttpError(400, "Placar inválido");
  }
  db.transaction(() => {
    const m = db
      .prepare("SELECT status FROM matches WHERE id = ?")
      .get(matchId);
    if (!m) throw new HttpError(404, "Partida não encontrada");
    if (m.status !== "scheduled")
      throw new HttpError(409, "Partida já encerrada ou cancelada");

    const result =
      homeScore > awayScore ? "home" : homeScore < awayScore ? "away" : "draw";
    db.prepare(
      "UPDATE matches SET status = 'finished', home_score = ?, away_score = ? WHERE id = ?"
    ).run(homeScore, awayScore, matchId);

    const pending = db
      .prepare(
        "SELECT id, bet_id, selection FROM bet_selections WHERE match_id = ? AND status = 'pending'"
      )
      .all(matchId);
    const upd = db.prepare("UPDATE bet_selections SET status = ? WHERE id = ?");
    const betIds = new Set();
    for (const s of pending) {
      upd.run(s.selection === result ? "won" : "lost", s.id);
      betIds.add(s.bet_id);
    }
    for (const b of betIds) settleIfDone(b, actorId, ip);

    audit({
      actorId,
      action: "match.result",
      entity: "match",
      entityId: matchId,
      data: { homeScore, awayScore, result },
      ip,
    });
  })();
}

function voidMatch(matchId, actorId, ip) {
  db.transaction(() => {
    const m = db
      .prepare("SELECT status FROM matches WHERE id = ?")
      .get(matchId);
    if (!m) throw new HttpError(404, "Partida não encontrada");
    if (m.status !== "scheduled")
      throw new HttpError(409, "Partida já encerrada ou cancelada");

    db.prepare("UPDATE matches SET status = 'cancelled' WHERE id = ?").run(
      matchId
    );
    const pending = db
      .prepare(
        "SELECT DISTINCT bet_id FROM bet_selections WHERE match_id = ? AND status = 'pending'"
      )
      .all(matchId);
    db.prepare(
      "UPDATE bet_selections SET status = 'void' WHERE match_id = ? AND status = 'pending'"
    ).run(matchId);
    for (const { bet_id } of pending) settleIfDone(bet_id, actorId, ip);

    audit({
      actorId,
      action: "match.void",
      entity: "match",
      entityId: matchId,
      ip,
    });
  })();
}

module.exports = {
  RULES,
  adjustBalance,
  getBet,
  placeBet,
  setResult,
  voidMatch,
};
