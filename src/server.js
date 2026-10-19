require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const path = require("path");
const db = require("./db");
const { audit } = require("./services/audit");
const {
  adjustBalance,
  getBet,
  placeBet,
  setResult,
  voidMatch,
} = require("./services/betting");
const { requireAuth, requireAdmin } = require("./middleware/auth");
const { HttpError } = require("./errors");

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 16) {
  console.warn("[AVISO] Defina um JWT_SECRET forte no .env");
}

const app = express();
app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
});
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
const admin = [requireAuth, requireAdmin];

const sign = (id) =>
  jwt.sign({ sub: id }, process.env.JWT_SECRET, { expiresIn: "12h" });
const SELECTIONS = ["home", "draw", "away"];

function parseOdds(o) {
  const v = {};
  for (const k of SELECTIONS) {
    v[k] = Number(o?.[k]);
    if (!(v[k] > 1 && v[k] <= 1000))
      throw new HttpError(400, `Odd "${k}" inválida (deve ser > 1.00)`);
  }
  return v;
}

// ---------- AUTENTICAÇÃO ----------
app.post(
  "/api/auth/register",
  authLimiter,
  wrap(async (req, res) => {
    const name = String(req.body?.name || "").trim();
    const email = String(req.body?.email || "")
      .toLowerCase()
      .trim();
    const password = String(req.body?.password || "");
    if (!name || !email.includes("@") || password.length < 8) {
      throw new HttpError(
        400,
        "Dados inválidos (senha com no mínimo 8 caracteres)"
      );
    }
    const hash = await bcrypt.hash(password, 12);
    try {
      const id = Number(
        db
          .prepare(
            "INSERT INTO users (name, email, password_hash) VALUES (?,?,?)"
          )
          .run(name, email, hash).lastInsertRowid
      );
      audit({
        actorId: id,
        action: "user.register",
        entity: "user",
        entityId: id,
        ip: req.ip,
      });
      res.status(201).json({ token: sign(id) });
    } catch (e) {
      if (e.code === "SQLITE_CONSTRAINT_UNIQUE")
        throw new HttpError(409, "E-mail já cadastrado");
      throw e;
    }
  })
);

app.post(
  "/api/auth/login",
  authLimiter,
  wrap(async (req, res) => {
    const email = String(req.body?.email || "")
      .toLowerCase()
      .trim();
    const u = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    const ok =
      u &&
      u.active &&
      (await bcrypt.compare(String(req.body?.password || ""), u.password_hash));
    if (!ok) {
      audit({
        action: "auth.login_failed",
        entity: "user",
        data: { email },
        ip: req.ip,
      });
      throw new HttpError(401, "Credenciais inválidas");
    }
    audit({
      actorId: u.id,
      action: "auth.login",
      entity: "user",
      entityId: u.id,
      ip: req.ip,
    });
    res.json({ token: sign(u.id) });
  })
);

app.get("/api/me", requireAuth, (req, res) => {
  res.json(
    db
      .prepare(
        "SELECT id, name, email, role, balance_cents FROM users WHERE id = ?"
      )
      .get(req.user.id)
  );
});

// ---------- PÚBLICO: TIMES E PARTIDAS ----------
app.get("/api/teams", (req, res) => {
  res.json(
    db
      .prepare(
        "SELECT id, name, sport FROM teams WHERE name LIKE ? ORDER BY name LIMIT 100"
      )
      .all(`%${req.query.q || ""}%`)
  );
});

app.get("/api/matches", (req, res) => {
  const q = `%${req.query.q || ""}%`;
  const matches = db
    .prepare(
      `
    SELECT m.id, m.starts_at, m.status, m.home_score, m.away_score,
           h.name AS home, a.name AS away
    FROM matches m
    JOIN teams h ON h.id = m.home_team_id
    JOIN teams a ON a.id = m.away_team_id
    WHERE (h.name LIKE ? OR a.name LIKE ?) AND m.status IN ('scheduled','finished')
    ORDER BY m.starts_at LIMIT 200`
    )
    .all(q, q);

  const oddsStmt = db.prepare(
    "SELECT selection, price FROM odds WHERE match_id = ? AND active = 1"
  );
  res.json(matches.map((m) => ({ ...m, odds: oddsStmt.all(m.id) })));
});

// ---------- APOSTAS E CARTEIRA (JOGADOR) ----------
app.post("/api/bets", requireAuth, (req, res) => {
  const bet = placeBet({
    userId: req.user.id,
    stakeCents: Number(req.body?.stakeCents),
    selections: req.body?.selections,
    ip: req.ip,
  });
  res.status(201).json(bet);
});

app.get("/api/bets", requireAuth, (req, res) => {
  res.json(
    db
      .prepare(
        "SELECT * FROM bets WHERE user_id = ? ORDER BY id DESC LIMIT 100"
      )
      .all(req.user.id)
  );
});

app.get("/api/bets/:id", requireAuth, (req, res) => {
  const bet = getBet(Number(req.params.id));
  if (!bet || (bet.user_id !== req.user.id && req.user.role !== "admin")) {
    throw new HttpError(404, "Aposta não encontrada");
  }
  res.json(bet);
});

app.get("/api/wallet", requireAuth, (req, res) => {
  res.json(
    db
      .prepare(
        "SELECT * FROM ledger WHERE user_id = ? ORDER BY id DESC LIMIT 200"
      )
      .all(req.user.id)
  );
});

// ---------- ADMIN: TIMES ----------
app.post("/api/admin/teams", admin, (req, res) => {
  const name = String(req.body?.name || "").trim();
  if (!name) throw new HttpError(400, "Nome obrigatório");
  try {
    const id = Number(
      db
        .prepare("INSERT INTO teams (name, sport) VALUES (?,?)")
        .run(name, req.body?.sport || "futebol").lastInsertRowid
    );
    audit({
      actorId: req.user.id,
      action: "team.create",
      entity: "team",
      entityId: id,
      data: { name },
      ip: req.ip,
    });
    res.status(201).json({ id });
  } catch (e) {
    if (e.code === "SQLITE_CONSTRAINT_UNIQUE")
      throw new HttpError(409, "Time já existe");
    throw e;
  }
});

// ---------- ADMIN: PARTIDAS E ODDS ----------
app.post("/api/admin/matches", admin, (req, res) => {
  const h = Number(req.body?.homeTeamId);
  const a = Number(req.body?.awayTeamId);
  const odds = parseOdds(req.body?.odds);
  const start = Date.parse(req.body?.startsAt);
  if (!h || !a || h === a) throw new HttpError(400, "Times inválidos");
  if (Number.isNaN(start)) throw new HttpError(400, "Data inválida");
  const teams = db
    .prepare("SELECT COUNT(*) AS c FROM teams WHERE id IN (?,?)")
    .get(h, a).c;
  if (teams !== 2) throw new HttpError(400, "Time não encontrado");

  const id = db.transaction(() => {
    const matchId = Number(
      db
        .prepare(
          "INSERT INTO matches (home_team_id, away_team_id, starts_at) VALUES (?,?,?)"
        )
        .run(h, a, new Date(start).toISOString()).lastInsertRowid
    );
    const ins = db.prepare(
      "INSERT INTO odds (match_id, selection, price) VALUES (?,?,?)"
    );
    for (const s of SELECTIONS) ins.run(matchId, s, odds[s]);
    audit({
      actorId: req.user.id,
      action: "match.create",
      entity: "match",
      entityId: matchId,
      data: { homeTeamId: h, awayTeamId: a, startsAt: req.body.startsAt, odds },
      ip: req.ip,
    });
    return matchId;
  })();
  res.status(201).json({ id });
});

app.patch("/api/admin/matches/:id/odds", admin, (req, res) => {
  const id = Number(req.params.id);
  const odds = parseOdds(req.body);
  db.transaction(() => {
    const m = db.prepare("SELECT status FROM matches WHERE id = ?").get(id);
    if (!m) throw new HttpError(404, "Partida não encontrada");
    if (m.status !== "scheduled")
      throw new HttpError(409, "Odds só podem ser alteradas antes da partida");
    const before = db
      .prepare("SELECT selection, price FROM odds WHERE match_id = ?")
      .all(id);
    const upd = db.prepare(
      "UPDATE odds SET price = ?, updated_at = datetime('now') WHERE match_id = ? AND selection = ?"
    );
    for (const s of SELECTIONS) upd.run(odds[s], id, s);
    audit({
      actorId: req.user.id,
      action: "odds.update",
      entity: "match",
      entityId: id,
      data: { before, after: odds },
      ip: req.ip,
    });
  })();
  res.json({ ok: true });
});

app.post("/api/admin/matches/:id/result", admin, (req, res) => {
  setResult(
    Number(req.params.id),
    Number(req.body?.homeScore),
    Number(req.body?.awayScore),
    req.user.id,
    req.ip
  );
  res.json({ ok: true });
});

app.post("/api/admin/matches/:id/void", admin, (req, res) => {
  voidMatch(Number(req.params.id), req.user.id, req.ip);
  res.json({ ok: true });
});

// ---------- ADMIN: USUÁRIOS, SALDO, AUDITORIA ----------
app.get("/api/admin/users", admin, (req, res) => {
  res.json(
    db
      .prepare(
        "SELECT id, name, email, role, balance_cents, active, created_at FROM users ORDER BY id DESC LIMIT 500"
      )
      .all()
  );
});

app.patch("/api/admin/users/:id/active", admin, (req, res) => {
  const id = Number(req.params.id);
  const active = req.body?.active ? 1 : 0;
  const r = db
    .prepare("UPDATE users SET active = ? WHERE id = ?")
    .run(active, id);
  if (!r.changes) throw new HttpError(404, "Usuário não encontrado");
  audit({
    actorId: req.user.id,
    action: "user.active",
    entity: "user",
    entityId: id,
    data: { active },
    ip: req.ip,
  });
  res.json({ ok: true });
});

app.post("/api/admin/users/:id/deposit", admin, (req, res) => {
  const id = Number(req.params.id);
  const amount = Number(req.body?.amountCents);
  if (!Number.isInteger(amount) || amount <= 0)
    throw new HttpError(400, "Valor inválido");
  db.transaction(() => {
    adjustBalance(id, amount, "deposit", `admin:${req.user.id}`);
    audit({
      actorId: req.user.id,
      action: "wallet.deposit",
      entity: "user",
      entityId: id,
      data: { amount },
      ip: req.ip,
    });
  })();
  res.json({ ok: true });
});

app.get("/api/admin/audit", admin, (req, res) => {
  res.json(
    db.prepare("SELECT * FROM audit_logs ORDER BY id DESC LIMIT 500").all()
  );
});

// Tratamento de erros
app.use((err, req, res, next) => {
  if (err instanceof HttpError)
    return res.status(err.status).json({ error: err.message });
  if (err.type === "entity.parse.failed")
    return res.status(400).json({ error: "JSON inválido" });
  console.error(err);
  res.status(500).json({ error: "Erro interno" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Servidor rodando em http://localhost:${PORT}`)
);
