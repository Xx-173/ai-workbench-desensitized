/**
 * Ports — the seam between the business layer and the runtime that hosts it.
 *
 * Design rule: this package declares WHAT it needs, never WHO provides it.
 * Everything here is a narrow interface so the business modules below can be
 * unit-tested with a stub instead of booting the whole Agent runtime.
 *
 * Nothing in this file contains a real endpoint, credential or person — see
 * `config/agents.example.json` for the placeholder-only input format.
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

/** Minimal JSON-Schema-ish shape. Enough to reject malformed tool input. */
export interface InputSchema {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, InputSchemaField>>;
  readonly required?: readonly string[];
}

export interface InputSchemaField {
  readonly type: 'string' | 'number' | 'boolean' | 'array';
  readonly description: string;
  readonly items?: { readonly type: 'string' | 'number' };
}

/** One transcript slice produced by video parsing. Synthetic values in tests. */
export interface TranscriptSegment {
  readonly startSec: number;
  readonly endSec: number;
  readonly text: string;
}

/**
 * The subset of a session-scoped tool context the business layer relies on.
 * Mirrors the shape injected by the base; kept local so this package stays
 * dependency-free and independently testable.
 */
export interface ToolContext {
  readonly sessionId: string;
  readonly workspacePath: string;
  /** Business task id; defaults to the session id when the caller omits it. */
  readonly taskId?: string;
  /** Read-only secret lookup by placeholder name, e.g. `VOICE_SERVICE_TOKEN`. */
  readonly credentials: CredentialReader;
  /** Structured progress sink (see business-events.ts). */
  readonly progress?: (event: unknown) => void;
  /** Optional identity supplied by an authenticated web/control-plane caller. */
  readonly actor?: {
    readonly userId: string;
    readonly departmentId?: string;
  };
}

export interface CredentialReader {
  /**
   * Returns the secret registered under `name`, or `null` when unconfigured.
   * Implementations MUST NOT fall back to a baked-in default.
   */
  read(name: string): string | null;
}

export interface ToolResult {
  /** Serialized payload handed back to the agent. */
  readonly content: string;
  readonly isError: boolean;
}

export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};
