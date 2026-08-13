import { getDb } from "./src/store/db";
const db = getDb("./data/mirais.db");

// Get proxies with US country if available, or just any
const usProxies = db.query("SELECT host, port, country, scheme FROM proxy_proxies WHERE country='US' LIMIT 10").all();
console.log("US proxies:", usProxies.length);

const anyProxies = db.query("SELECT host, port, country, scheme FROM proxy_proxies LIMIT 20").all();
console.log("Any proxies:", JSON.stringify(anyProxies, null, 2));

// Count by country
const byCountry = db.query("SELECT country, COUNT(*) as c FROM proxy_proxies WHERE country IS NOT NULL GROUP BY country ORDER BY c DESC LIMIT 15").all();
console.log("By country:", JSON.stringify(byCountry, null, 2));

db.close();
