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
