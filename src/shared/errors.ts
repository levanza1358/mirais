export type OpenAIErrorType =
  | "authentication_error"
  | "rate_limit_error"
  | "invalid_request_error"
  | "server_error"
  | "not_found_error";

export class GatewayError extends Error {
  constructor(
    public status: number,
    public type: OpenAIErrorType,
    message: string,
    public code?: string,
    /**
     * `Retry-After` as parsed from the upstream response headers, in seconds.
     * Kept structured (not just embedded in `message`) so the cooldown logic
     * honours the upstream's suggestion verbatim instead of re-parsing text.
     */
    public retryAfterSec?: number,
    /**
     * Per-minute request-window hints. Providers such as Atria return these on
     * both 429s *and* successful responses (`x-rpm-limit`, `x-rpm-remaining`),
     * so they can drive adaptive backoff.
     */
    public rateLimit?: { limit?: number; remaining?: number },
  ) {
    super(message);
    this.name = "GatewayError";
  }

  toJSON() {
    return {
      error: {
        message: this.message,
        type: this.type,
        code: this.code ?? null,
      },
    };
  }
}

export class AdminError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "AdminError";
  }

  toJSON() {
    return { error: this.message };
  }
}

export function isRetriableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}
