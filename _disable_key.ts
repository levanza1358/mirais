import { Database } from "bun:sqlite";
const db = new Database("./data/mirais.db");
db.query("UPDATE gateway_keys SET enabled = 0 WHERE enabled = 1").run();
const row = db.query("SELECT label, enabled FROM gateway_keys").get();
console.log("after:", JSON.stringify(row));