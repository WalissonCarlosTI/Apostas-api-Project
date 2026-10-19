const jwt = require("jsonwebtoken");
const db = require("../db");

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Não autenticado" });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = db
      .prepare("SELECT id, name, email, role, active FROM users WHERE id = ?")
      .get(payload.sub);
    if (!user || !user.active)
      return res.status(401).json({ error: "Não autenticado" });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: "Token inválido ou expirado" });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin")
    return res.status(403).json({ error: "Acesso restrito" });
  next();
}

module.exports = { requireAuth, requireAdmin };
