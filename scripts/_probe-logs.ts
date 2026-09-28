import { SQL } from "bun";

const credentials = await Bun.file(".mysql/credentials.json").json() as {
  port: number;
  database: string;
  username: string;
  password: string;
};
const db = new SQL({
  adapter: "mysql",
  hostname: "127.0.0.1",
  port: credentials.port,
  database: credentials.database,
  username: credentials.username,
  password: credentials.password,
  tls: true,
});
const counts = await db.unsafe("SELECT kind, status, COUNT(*) AS count, MIN(ts) AS oldest, MAX(ts) AS newest FROM request_logs GROUP BY kind, status ORDER BY kind, status");
const indexes = await db.unsafe<Array<{ Key_name: string; Seq_in_index: number; Column_name: string; Cardinality: number | null }>>("SHOW INDEX FROM request_logs");
const sizes = await db.unsafe("SELECT COUNT(*) AS rows_count, COALESCE(SUM(CHAR_LENGTH(request_body)),0) AS request_chars, COALESCE(SUM(CHAR_LENGTH(response_body)),0) AS response_chars FROM request_logs");
const recent = await db.unsafe("SELECT id, ts, kind, status, requested_model, provider, CHAR_LENGTH(request_body) AS req_size, CHAR_LENGTH(response_body) AS resp_size FROM request_logs ORDER BY ts DESC LIMIT 10");
console.log(JSON.stringify({
  counts,
  sizes,
  indexes: indexes.map((row) => ({ key: row.Key_name, seq: row.Seq_in_index, col: row.Column_name, cardinality: row.Cardinality })),
  recent,
}, null, 2));
await db.close();
