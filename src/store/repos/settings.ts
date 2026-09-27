import type { Database } from "../sql";

export class SettingsRepo {
  constructor(private db: Database) {}

  async get(key: string): Promise<string | null> {
    const row = await this.db.query("SELECT value FROM settings WHERE `key` = ?").get<{ value: string }>(key);
    return row?.value ?? null;
  }

  async getJson<T>(key: string): Promise<T | null> {
    const v = await this.get(key);
    if (v === null) return null;
    try {
      return JSON.parse(v) as T;
    } catch {
      return null;
    }
  }

  async set(key: string, value: string): Promise<void> {
    const existing = await this.db.query("SELECT `key` FROM settings WHERE `key` = ?").get<{ key: string }>(key);
    if (existing) {
      await this.db.query("UPDATE settings SET value = ? WHERE `key` = ?").run(value, key);
    } else {
      await this.db.query("INSERT INTO settings (`key`, value) VALUES (?, ?)").run(key, value);
    }
  }

  setJson(key: string, value: unknown): Promise<void> {
    return this.set(key, JSON.stringify(value));
  }
}
