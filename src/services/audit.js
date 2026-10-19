const db = require("../db");

const insert = db.prepare(
  "INSERT INTO audit_logs (actor_id, action, entity, entity_id, data, ip) VALUES (?,?,?,?,?,?)"
);

function audit({
  actorId = null,
  action,
  entity,
  entityId = null,
  data = null,
  ip = null,
}) {
  insert.run(
    actorId,
    action,
    entity,
    entityId != null ? String(entityId) : null,
    data != null ? JSON.stringify(data) : null,
    ip
  );
}

module.exports = { audit };
