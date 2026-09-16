/**
 * Account freeze / access revocation (resume bullet 5, the self-developed part).
 *
 * The base provides no account model at all, so this is business code sitting
 * on top of its service layer. The bug worth designing against is not "can I
 * forbid an action" — it is **"the freeze already happened and it didn't take
 * effect"**. Three things keep working after a naive freeze:
 *
 *   1. already-issued session credentials that have not expired yet
 *   2. long-lived sockets that were authenticated once at connect time
 *   3. authorization state cached in memory and never re-read
 *
 * So revocation is implemented on three independent axes. Interviewee note:
 * all three are needed. Any two leave a window.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Clock } from './ports.ts';
import { systemClock } from './ports.ts';

/** Kept distinct from the team-directory's active/disabled account state. */
export type RevocationAccountStatus = 'active' | 'frozen';

export interface AccountRecord {
  readonly id: string;
  /** Display handle. Never carries a real person's identity in fixtures. */
  readonly login: string;
  readonly status: RevocationAccountStatus;
  /** Monotonically increasing. Every status transition bumps it. */
  readonly statusVersion: number;
  readonly frozenAt?: number;
  readonly reason?: string;
}

export interface AccountStore {
  findById(accountId: string): Promise<AccountRecord | null>;
  /**
   * Atomically status→frozen and statusVersion+1.
   * Returns null when the account does not exist.
   */
  freeze(accountId: string, reason: string, atMs: number): Promise<AccountRecord | null>;
}

// ---------------------------------------------------------------------------
// Layer 1 — credential: make already-issued tokens unverifiable immediately
// ---------------------------------------------------------------------------

export interface CredentialMaterial {
  readonly token: string;
  readonly accountId: string;
  readonly statusVersion: number;
  readonly mac: string;
}

function credentialPayload(token: string, accountId: string, statusVersion: number): string {
  return `${token}.${accountId}.${statusVersion}`;
}

/**
 * Binds statusVersion into the signature. Freezing bumps the version, so every
 * previously issued credential fails verification on the signature alone —
 * no revocation list, no waiting for expiry.
 */
export function signSessionCredential(
  secret: string,
  input: Pick<CredentialMaterial, 'token' | 'accountId' | 'statusVersion'>,
): CredentialMaterial {
  const payload = credentialPayload(input.token, input.accountId, input.statusVersion);
  const mac = createHmac('sha256', secret).update(payload).digest('hex');
  return { ...input, mac };
}

export function verifySessionCredential(secret: string, material: CredentialMaterial, currentVersion: number): boolean {
  if (material.statusVersion !== currentVersion) return false;
  const expected = Buffer.from(signSessionCredential(secret, material).mac, 'hex');
  const actual = Buffer.from(material.mac, 'hex');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

// ---------------------------------------------------------------------------
// Layer 2 — connections: actively tear down sockets that outlive the freeze
// ---------------------------------------------------------------------------

export interface CloseableConnection {
  readonly id: string;
  close(code?: number, reason?: string): void;
}

/** STATUS codes are WebSocket semantics; 1008 = policy violation. */
export const REVOKE_CLOSE_CODE = 1008;

export class AccountConnectionRegistry {
  private readonly connections = new Map<string, Set<CloseableConnection>>();

  add(accountId: string, connection: CloseableConnection): void {
    const bucket = this.connections.get(accountId) ?? new Set<CloseableConnection>();
    bucket.add(connection);
    this.connections.set(accountId, bucket);
  }

  remove(accountId: string, connection: CloseableConnection): void {
    this.connections.get(accountId)?.delete(connection);
  }

  countFor(accountId: string): number {
    return this.connections.get(accountId)?.size ?? 0;
  }

  revokeAll(accountId: string, reason = 'account frozen'): number {
    const bucket = this.connections.get(accountId);
    if (!bucket || bucket.size === 0) return 0;
    const doomed = [...bucket];
    bucket.clear();
    for (const connection of doomed) connection.close(REVOKE_CLOSE_CODE, reason);
    return doomed.length;
  }
}

// ---------------------------------------------------------------------------
// Layer 3 — execution: re-read status with bounded staleness, fail closed
// ---------------------------------------------------------------------------

export type DecisionSource = 'cache' | 'store' | 'fail-closed';

export interface AuthorizationDecision {
  readonly allowed: boolean;
  readonly reason: string;
  readonly source: DecisionSource;
  readonly statusVersion?: number;
}

export interface AuthorizerOptions {
  readonly store: AccountStore;
  /** Bounded staleness window. Zero means "always read through". */
  readonly cacheTtlMs?: number;
  readonly clock?: Clock;
}

interface CacheEntry {
  readonly status: RevocationAccountStatus;
  readonly statusVersion: number;
  readonly expiresAt: number;
}

/**
 * Deliberate trade-off: every tool call could read the store, but that puts a
 * read on the hot path. A short TTL plus **explicit invalidation on freeze**
 * gives bounded staleness instead of unbounded caching. Revocation latency is
 * a security property; throughput is a performance property. When they
 * conflict, choose the first.
 */
export class ToolCallAuthorizer {
  private readonly store: AccountStore;
  private readonly cacheTtlMs: number;
  private readonly clock: Clock;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: AuthorizerOptions) {
    this.store = options.store;
    this.cacheTtlMs = options.cacheTtlMs ?? 0;
    this.clock = options.clock ?? systemClock;
  }

  invalidate(accountId: string): void {
    this.cache.delete(accountId);
  }

  async authorize(accountId: string): Promise<AuthorizationDecision> {
    const now = this.clock.now();
    if (this.cacheTtlMs > 0) {
      const cached = this.cache.get(accountId);
      if (cached && cached.expiresAt > now) {
        return {
          allowed: cached.status === 'active',
          reason: cached.status === 'active' ? 'cached active' : 'cached frozen',
          source: 'cache',
          statusVersion: cached.statusVersion,
        };
      }
      if (cached) this.cache.delete(accountId);
    }

    let record: AccountRecord | null;
    try {
      record = await this.store.findById(accountId);
    } catch (err) {
      // Fail closed: an unavailable store must never read as "allowed".
      return { allowed: false, reason: `store unavailable: ${(err as Error).message}`, source: 'fail-closed' };
    }
    if (!record) return { allowed: false, reason: 'account not found', source: 'fail-closed' };

    if (this.cacheTtlMs > 0) {
      this.cache.set(accountId, { status: record.status, statusVersion: record.statusVersion, expiresAt: now + this.cacheTtlMs });
    }
    return {
      allowed: record.status === 'active',
      reason: record.status === 'active' ? 'store active' : 'store frozen',
      source: 'store',
      statusVersion: record.statusVersion,
    };
  }
}

// ---------------------------------------------------------------------------
// Orchestration — the order here is the whole point
// ---------------------------------------------------------------------------

export interface RevocationReport {
  readonly accountId: string;
  readonly statusVersion: number;
  readonly credentialsInvalidated: boolean;
  readonly cacheCleared: boolean;
  readonly connectionsClosed: number;
}

export interface RevocationTargets {
  readonly store: AccountStore;
  readonly authorizer: ToolCallAuthorizer;
  readonly connections: AccountConnectionRegistry;
  readonly clock?: Clock;
}

/**
 * Why this order: bump the version FIRST. If sockets are closed before the
 * version moves, a reconnecting client can obtain a valid session during the
 * gap. With version-first, everything observed afterwards is unverifiable.
 */
export async function revokeAccess(
  accountId: string,
  targets: RevocationTargets,
  reason = 'account frozen',
): Promise<RevocationReport> {
  const clock = targets.clock ?? systemClock;
  const frozen = await targets.store.freeze(accountId, reason, clock.now());
  if (!frozen) {
    // Still revoke locally — a missing record must not leave sockets open.
    targets.authorizer.invalidate(accountId);
    const connectionsClosed = targets.connections.revokeAll(accountId, reason);
    return { accountId, statusVersion: -1, credentialsInvalidated: true, cacheCleared: true, connectionsClosed };
  }
  targets.authorizer.invalidate(accountId);
  const connectionsClosed = targets.connections.revokeAll(accountId, reason);
  return {
    accountId,
    statusVersion: frozen.statusVersion,
    credentialsInvalidated: true,
    cacheCleared: true,
    connectionsClosed,
  };
}
