/**
 * Structured error types surfaced to MCP clients. Each carries enough
 * context for the Lead agent to recover (typically: re-snapshot, then retry).
 *
 * Snapshot freshness rule: any state-changing call invalidates the current
 * ref index; a stale ref returns `stale_ref` with the last valid snapshot
 * timestamp so the Lead can re-snapshot and retry.
 */

export type ErrorCode =
  | "stale_ref"
  | "unknown_ref"
  | "unknown_session"
  | "unsupported_platform"
  | "unsupported_engine"
  | "not_implemented_in_v01"
  | "not_implemented_in_v02"
  | "invalid_input"
  | "ambiguous_query"
  | "engine_error"
  | "cwv_unsupported_browser"
  | "har_unavailable";

export class RolepodMcpError extends Error {
  override readonly name = "RolepodMcpError";
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
  }

  toJSON(): { code: ErrorCode; message: string; detail?: Record<string, unknown> } {
    return {
      code: this.code,
      message: this.message,
      ...(this.detail ? { detail: this.detail } : {}),
    };
  }
}

export class StaleRefError extends RolepodMcpError {
  constructor(sessionId: string, ref: string, lastValidSnapshotAt: string | null) {
    super("stale_ref", `Ref "${ref}" is stale — re-snapshot before retrying.`, {
      session_id: sessionId,
      ref,
      last_valid_snapshot_at: lastValidSnapshotAt,
    });
  }
}

export class UnknownRefError extends RolepodMcpError {
  constructor(sessionId: string, ref: string) {
    super("unknown_ref", `Ref "${ref}" was not found in the current snapshot.`, {
      session_id: sessionId,
      ref,
    });
  }
}

export class UnknownSessionError extends RolepodMcpError {
  constructor(sessionId: string) {
    super("unknown_session", `No open session with id "${sessionId}".`, {
      session_id: sessionId,
    });
  }
}

export class UnsupportedPlatformError extends RolepodMcpError {
  constructor(platform: string) {
    super(
      "unsupported_platform",
      `Platform "${platform}" is not supported in v0.1 — only "web" is implemented. Mobile (ios/android) ships in v0.3.`,
      { platform },
    );
  }
}
