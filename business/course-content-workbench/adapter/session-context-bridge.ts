/**
 * Session context bridge — adapts the base's SessionToolContext into the
 * narrow ToolContext this business layer consumes.
 *
 * ## Why this file exists instead of importing the base package
 *
 * TypeScript is structurally typed, so accepting a shape rather than a class is
 * both safer and cheaper here: any object honouring `SessionContextLike` works,
 * whether it came from the Electron main process, the headless server, or a
 * test fixture. It also means this layer keeps zero hard edges on base internals
 * and does not need to be a workspace member to compile.
 *
 * The risk of structural typing is drift — if the base renames `workspacePath`
 * the code still compiles while silently reading `undefined`. That is what
 * `upstream-contract.test.ts` guards: it parses the real upstream source file
 * and fails if the required members disappear.
 *
 * Shape verified against:
 *   packages/session-tools-core/src/context.ts  @ upstream v0.13.3
 */

import type { CredentialReader, ToolContext } from '../src/ports.ts';

/** The slice of the base's FileSystemInterface actually used here. */
export interface FileSystemLike {
  exists(path: string): boolean;
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  readdir(path: string): string[];
}

/** Minimal shape for a base source, only what credential lookup needs. */
export interface SourceLike {
  readonly config: { readonly slug: string };
}

/** Minimal shape for the base credential manager. */
export interface CredentialManagerLike {
  getToken(source: SourceLike): Promise<string | null>;
  hasValidCredentials(source: SourceLike): Promise<boolean>;
}

export interface SessionContextLike {
  readonly sessionId: string;
  readonly workspacePath: string;
  readonly fs: FileSystemLike;
  readonly credentialManager?: CredentialManagerLike;
  readonly loadSourceConfig?: (sourceSlug: string) => unknown;
}

export interface CredentialBindingMap {
  /**
   * Maps a business placeholder name (e.g. `VOICE_SERVICE_TOKEN`) onto the base
   * source slug that actually holds it (e.g. `voice-service`).
   */
  readonly [placeholderName: string]: string;
}

const STUB_SOURCE = (slug: string): SourceLike => ({ config: { slug } });

/**
 * Builds a plain reader from an already-resolved map. Used for headless runs
 * and tests, and for whatever the async resolver handed back.
 */
export function staticCredentials(values: Readonly<Record<string, string | null>>): CredentialReader {
  return { read: (name) => values[name] ?? null };
}

/**
 * Async credential resolution — the one actually used against the base.
 *
 * The base's credential manager is async (keychain / OAuth refresh), so tokens
 * are resolved once per task start and then handed to the business layer as a
 * plain synchronous reader.
 *
 * A failing or absent credential store must look exactly like "not configured"
 * to the business layer, which then fails loudly and names the placeholder. It
 * must never look like a valid empty token.
 */
export async function resolveSessionCredentials(
  base: SessionContextLike,
  bindings: CredentialBindingMap,
  names: readonly string[],
  overrides: Readonly<Record<string, string | null>> = {},
): Promise<CredentialReader> {
  const manager = base.credentialManager;
  const resolved = new Map<string, string | null>();

  await Promise.all(
    names.map(async (name) => {
      if (Object.prototype.hasOwnProperty.call(overrides, name)) {
        resolved.set(name, overrides[name] ?? null);
        return;
      }
      const slug = bindings[name];
      if (!slug || !manager) {
        resolved.set(name, null);
        return;
      }
      try {
        resolved.set(name, await manager.getToken(STUB_SOURCE(slug)));
      } catch {
        resolved.set(name, null);
      }
    }),
  );

  return staticCredentials(Object.fromEntries(resolved));
}

export interface AdaptOptions {
  /** Falls back to the session id when the host has no finer-grained task id. */
  readonly taskId?: string;
  readonly taskIdFromInput?: (input: Record<string, unknown>) => string | undefined;
  readonly credentials: CredentialReader;
  readonly progress?: (event: unknown) => void;
}

/**
 * The bridge itself. Everything downstream only ever sees `ToolContext`, so the
 * business modules stay ignorant of both the base and the transport.
 */
export function adaptSessionContext(base: SessionContextLike, options: AdaptOptions): ToolContext {
  const { credentials, progress } = options;
  return {
    sessionId: base.sessionId,
    workspacePath: base.workspacePath,
    ...(options.taskId !== undefined ? { taskId: options.taskId } : {}),
    credentials,
    ...(progress !== undefined ? { progress } : {}),
  };
}
