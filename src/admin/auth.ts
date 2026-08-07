import { Elysia } from "elysia";
import type { Database } from "bun:sqlite";

/**
 * Compatibility endpoints for older dashboard bundles. Dashboard access is
 * deliberately passwordless; network access is controlled outside Mirais.
 */
export function authRoutes(_db: Database) {
  return new Elysia({ prefix: "/api/auth" })
    .get("/check", () => ({ authenticated: true, setup_required: false, passwordless: true }))
    .post("/login", () => ({ ok: true, passwordless: true }))
    .post("/logout", () => ({ ok: true }));
}