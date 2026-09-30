import type { SQL } from "bun";

export type SqlValue = string | number | bigint | boolean | Date | Uint8Array | null;
export type SqlDialect = "mysql" | "sqlite";

/**
 * Coerce a SQL numeric value to a JS number.
 *
 * MySQL types `SUM()`/`AVG()` over integer columns as DECIMAL, and Bun's MySQL
 * adapter hands DECIMAL back as a **string** — so `SUM(input_tokens)` arrives as
 * `"300581189"`, not `300581189`. Any JS `+` over two such values concatenates
 * digits instead of adding them (R1.11: token math is integer math), so
 * aggregates are normalized to `number` at the repo boundary.
 */
export function num(value: unknown, fallback = 0): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    if (value.trim() === "") return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

/**
 * Copy `row` with the listed aggregate columns coerced through `num()`.
 *
 * Apply this at the repo boundary to every non-aggregated numeric column read
 * out of a MySQL `SUM()`/`AVG()`: `COUNT(*)` is already a number and passes
 * through untouched, while DECIMAL aggregates become real numbers. The single
 * cast is the SQL boundary itself — the caller's `Row` type is what the query
 * claims to return, and this is where the claim is made true.
 */
export function coerceAggregates<Row extends object>(row: Row, fields: readonly (keyof Row)[]): Row {
  const out: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  for (const field of fields) {
    const key = field as string;
    out[key] = num(out[key]);
  }
  return out as Row;
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export class Database {
  constructor(private readonly client: SQL, readonly dialect: SqlDialect = "mysql") {}

  query(statement: string) {
    return {
      get: async <Row extends object>(...values: SqlValue[]): Promise<Row | null> => {
        return (await this.all<Row>(statement, values))[0] ?? null;
      },
      all: <Row extends object>(...values: SqlValue[]): Promise<Row[]> => {
        return this.all<Row>(statement, values);
      },
      run: async (...values: SqlValue[]): Promise<{ changes: number }> => {
        const prepared = this.prepareLimit(statement, values);
        let result: unknown;
        try {
          const sql = inlineSql(prepared.statement, this.bind(prepared.values));
          result = await this.client.unsafe<unknown>(sql);
        } catch (error) {
          throw error;
        }
        if (typeof result !== "object" || result === null) return { changes: 0 };
        const metadata = result as { affectedRows?: unknown; changes?: unknown };
        const changes = typeof metadata.affectedRows === "number"
          ? metadata.affectedRows
          : typeof metadata.changes === "number" ? metadata.changes : 0;
        return { changes };
      },
    };
  }

  transaction<Result>(work: (transactionDb: Database) => Promise<Result>): () => Promise<Result> {
    return () => this.client.begin((client) => work(new Database(client, this.dialect)));
  }

  async exec(statement: string): Promise<void> {
    await this.client.unsafe<unknown>(statement).simple();
  }

  close(): Promise<void> {
    return this.client.close();
  }

  private async all<Row extends object>(
    statement: string,
    values: readonly SqlValue[],
  ): Promise<Row[]> {
    const prepared = this.prepareLimit(statement, values);
    try {
      const sql = inlineSql(prepared.statement, this.bind(prepared.values));
      const rows = await this.client.unsafe<Row[]>(sql);
      if (this.dialect === "mysql") {
        for (const row of rows) {
          if (typeof row !== "object" || row === null) continue;
          for (const [key, value] of Object.entries(row)) {
            if (value instanceof Date) (row as Record<string, unknown>)[key] = value.toISOString();
          }
        }
      }
      return rows;
    } catch (error) {
      throw error;
    }
  }

  private bind(values: readonly SqlValue[]): SqlValue[] {
    return values.map((value) => this.dialect === "mysql" && typeof value === "string" && ISO_TIMESTAMP.test(value)
      ? new Date(value)
      : value);
  }

  private prepareLimit(statement: string, values: readonly SqlValue[]): { statement: string; values: readonly SqlValue[] } {
    if (this.dialect !== "mysql") return { statement, values };
    const pagination = /LIMIT \? OFFSET \?/.test(statement)
      ? { pattern: "LIMIT ? OFFSET ?", count: 2 }
      : /LIMIT \?/.test(statement) ? { pattern: "LIMIT ?", count: 1 } : null;
    if (!pagination) return { statement, values };
    const limit = values.at(-pagination.count);
    const offset = pagination.count === 2 ? values.at(-1) : undefined;
    if (!Number.isInteger(limit) || Number(limit) < 0 || (offset !== undefined && (!Number.isInteger(offset) || Number(offset) < 0))) {
      throw new Error("LIMIT/OFFSET must be non-negative integers");
    }
    return {
      statement: statement.replace(pagination.pattern, pagination.count === 2 ? `LIMIT ${limit} OFFSET ${offset}` : `LIMIT ${limit}`),
      values: values.slice(0, -pagination.count),
    };
  }
}

export async function selectRows<Row extends object>(
  db: Database,
  statement: string,
  values: readonly SqlValue[] = [],
): Promise<Row[]> {
  return db.query(statement).all<Row>(...values);
}

export async function selectOne<Row extends object>(
  db: Database,
  statement: string,
  values: readonly SqlValue[] = [],
): Promise<Row | null> {
  return db.query(statement).get<Row>(...values);
}

function inlineSql(statement: string, values: readonly SqlValue[]): string {
  let index = 0;
  return statement.replace(/\?/g, () => {
    const value = values[index++];
    if (value === undefined) throw new Error("SQL placeholder count mismatch");
    if (value === null) return "NULL";
    if (typeof value === "boolean") return value ? "1" : "0";
    if (typeof value === "number" || typeof value === "bigint") return String(value);
    if (value instanceof Date) return `'${value.toISOString().slice(0, 19).replace("T", " ")}.${String(value.getUTCMilliseconds()).padStart(3, "0")}'`;
    if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString("hex")}'`;
    return `'${String(value).replaceAll("'", "''")}'`;
  });
}