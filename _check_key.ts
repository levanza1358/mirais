import { Database } from "bun:sqlite";
const db = new Database("./data/mirais.db");
const row = db.query("SELECT 1 AS x FROM gateway_keys WHERE enabled = 1 LIMIT 1").get();
console.log("enabled exists:", JSON.stringify(row));
const all = db.query("SELECT id, label, enabled FROM gateway_keys").all();
console.log("all keys:", JSON.stringify(all));