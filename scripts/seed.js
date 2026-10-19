require("dotenv").config();
const bcrypt = require("bcryptjs");
const db = require("../src/db");

const email = (process.env.ADMIN_EMAIL || "admin@exemplo.com").toLowerCase();
const password = process.env.ADMIN_PASSWORD || "admin12345";

if (!db.prepare("SELECT id FROM users WHERE email = ?").get(email)) {
  db.prepare(
    "INSERT INTO users (name, email, password_hash, role) VALUES ('Admin', ?, ?, 'admin')"
  ).run(email, bcrypt.hashSync(password, 12));
  console.log("Admin criado:", email);
}

const insTeam = db.prepare("INSERT OR IGNORE INTO teams (name) VALUES (?)");
["Flamengo", "Palmeiras", "Corinthians", "São Paulo"].forEach((t) =>
  insTeam.run(t)
);

const ids = Object.fromEntries(
  db
    .prepare("SELECT id, name FROM teams")
    .all()
    .map((t) => [t.name, t.id])
);
const start = new Date(Date.now() + 2 * 86400000).toISOString();
const exists = db
  .prepare("SELECT id FROM matches WHERE home_team_id = ? AND away_team_id = ?")
  .get(ids["Flamengo"], ids["Palmeiras"]);
if (!exists) {
  const matchId = Number(
    db
      .prepare(
        "INSERT INTO matches (home_team_id, away_team_id, starts_at) VALUES (?,?,?)"
      )
      .run(ids["Flamengo"], ids["Palmeiras"], start).lastInsertRowid
  );
  const ins = db.prepare(
    "INSERT INTO odds (match_id, selection, price) VALUES (?,?,?)"
  );
  ins.run(matchId, "home", 2.1);
  ins.run(matchId, "draw", 3.2);
  ins.run(matchId, "away", 3.4);
  console.log("Partida de exemplo criada.");
}
console.log("Seed concluído.");
