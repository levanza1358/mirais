import { Database } from "bun:sqlite";
import { KeysRepo } from "./src/store/repos/keys";

const db = new Database("./data/mirais.db");
const repo = new KeysRepo(db);
const cur = db.query("SELECT id FROM gateway_keys LIMIT 1").get() as { id: string } | null;
if (!cur) {
  console.error("no key");
  process.exit(1);
}
const out = repo.rotate(cur.id);
if (!out) {
  console.error("rotate failed");
  process.exit(1);
}
console.log(JSON.stringify({ prefix: out.record.key_prefix, plaintext: out.plaintext }));
import { Buffer } from "node:buffer";