/**
 * Capability registry — the "register once" surface (resume bullet 1 / R17).
 *
 * The claim this module has to honour: adding one more AI capability requires
 * NOTHING but a new entry in `capabilities.ts`. No switch statement, no
 * registration call scattered across modules, no change to the agent core.
 *
 * Everything that varies per capability (name, schema, transport, how the
 * remote call is signed) lives in the entry. Everything invariant lives here.
 */

import type { InputSchema, JsonObject, JsonValue, ToolContext, ToolResult } from './ports.ts';

export type CapabilityId = string;

export type TransportKind = 'in-process' | 'mcp';

export interface CapabilityInvocationResult {
  readonly summary: string;
  readonly artifacts?: readonly string[];
  readonly raw?: JsonValue;
}

export interface CapabilityEntry {
  readonly id: CapabilityId;
  /** Tool name exposed to the agent. */
  readonly toolName: string;
  readonly description: string;
  readonly inputSchema: InputSchema;
  readonly transport: TransportKind;
  /**
   * The actual work. Receives an already-validated input plus the injected
   * tool context, so implementations never re-plumb session/workspace/secret.
   */
  readonly invoke: (ctx: ToolContext, input: JsonObject) => Promise<CapabilityInvocationResult>;
}

/** What gets handed to the agent runtime. Deliberately transport-agnostic. */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: InputSchema;
  readonly transport: TransportKind;
}

export class UnknownCapabilityError extends Error {
  constructor(id: CapabilityId) {
    super(`Unknown capability: ${id}`);
    this.name = 'UnknownCapabilityError';
  }
}

export class InvalidInputError extends Error {
  readonly field: string;
  constructor(field: string, reason: string) {
    super(`Invalid input for "${field}": ${reason}`);
    this.name = 'InvalidInputError';
    this.field = field;
  }
}

/** Structural validation — intentionally shallow, one level plus array items. */
export function validateInput(schema: InputSchema, input: JsonObject): void {
  for (const field of schema.required ?? []) {
    if (!(field in input) || input[field] === null || input[field] === undefined) {
      throw new InvalidInputError(field, 'required');
    }
  }
  for (const [key, value] of Object.entries(input)) {
    const field = schema.properties[key];
    if (!field) continue; // unknown keys are passed through untouched
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    if (field.type === 'array') {
      if (actual !== 'array') throw new InvalidInputError(key, `expected array, got ${actual}`);
      if (field.items) {
        for (const item of value as JsonValue[]) {
          if (typeof item !== field.items.type) {
            throw new InvalidInputError(key, `items must be ${field.items.type}`);
          }
        }
      }
    } else if (actual !== field.type) {
      throw new InvalidInputError(key, `expected ${field.type}, got ${actual}`);
    }
  }
}

export class CapabilityRegistry {
  private readonly entries = new Map<CapabilityId, CapabilityEntry>();

  register(entry: CapabilityEntry): this {
    if (this.entries.has(entry.id)) {
      throw new Error(`Capability already registered: ${entry.id}`);
    }
    this.entries.set(entry.id, entry);
    return this;
  }

  registerAll(entries: readonly CapabilityEntry[]): this {
    for (const entry of entries) this.register(entry);
    return this;
  }

  get(id: CapabilityId): CapabilityEntry {
    const entry = this.entries.get(id);
    if (!entry) throw new UnknownCapabilityError(id);
    return entry;
  }

  has(id: CapabilityId): boolean {
    return this.entries.has(id);
  }

  /** Reverse lookup for transports that address capabilities by tool name. */
  idForToolName(toolName: string): CapabilityId | null {
    for (const entry of this.entries.values()) {
      if (entry.toolName === toolName) return entry.id;
    }
    return null;
  }

  listToolDefinitions(): ToolDefinition[] {
    return [...this.entries.values()].map((e) => ({
      name: e.toolName,
      description: e.description,
      inputSchema: e.inputSchema,
      transport: e.transport,
    }));
  }

  /** Same implementation regardless of transport — the port looks identical. */
  async invoke(id: CapabilityId, ctx: ToolContext, input: JsonObject): Promise<CapabilityInvocationResult> {
    const entry = this.get(id);
    validateInput(entry.inputSchema, input);
    return entry.invoke(ctx, input);
  }

  /** Convenience wrapper producing the tool-shaped result the runtime expects. */
  async invokeAsTool(id: CapabilityId, ctx: ToolContext, input: JsonObject): Promise<ToolResult> {
    try {
      const result = await this.invoke(id, ctx, input);
      return { content: JSON.stringify({ summary: result.summary, artifacts: result.artifacts ?? [] }), isError: false };
    } catch (err) {
      return {
        content: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        isError: true,
      };
    }
  }
}
