import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AccountConnectionRegistry,
  REVOKE_CLOSE_CODE,
  ToolCallAuthorizer,
  revokeAccess,
  signSessionCredential,
  verifySessionCredential,
  type AccountRecord,
  type AccountStore,
  type CloseableConnection,
} from '../account-revocation.ts';

const SECRET = 'unit-test-secret-not-a-real-value';

class FakeStore implements AccountStore {
  private readonly records = new Map<string, AccountRecord>();

  constructor(initial: readonly AccountRecord[]) {
    for (const record of initial) this.records.set(record.id, record);
  }

  async findById(accountId: string): Promise<AccountRecord | null> {
    return this.records.get(accountId) ?? null;
  }

  async freeze(accountId: string, reason: string, atMs: number): Promise<AccountRecord | null> {
    const current = this.records.get(accountId);
    if (!current) return null;
    const next: AccountRecord = {
      ...current,
      status: 'frozen',
      statusVersion: current.statusVersion + 1,
      frozenAt: atMs,
      reason,
    };
    this.records.set(accountId, next);
    return next;
  }
}

const account = (over: Partial<AccountRecord> = {}): AccountRecord => ({
  id: 'acct-1',
  login: 'placeholder-handle',
  status: 'active',
  statusVersion: 1,
  ...over,
});

class FakeConnection implements CloseableConnection {
  readonly id: string;
  closed: { code?: number; reason?: string } | null = null;
  constructor(id: string) {
    this.id = id;
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
}

// ---------------------------------------------------------------------------
// Layer 1
// ---------------------------------------------------------------------------

test('a credential issued before the freeze stops verifying', () => {
  const before = signSessionCredential(SECRET, { token: 'tok-1', accountId: 'acct-1', statusVersion: 1 });
  assert.equal(verifySessionCredential(SECRET, before, 1), true);
  // freezing bumps the version to 2
  assert.equal(verifySessionCredential(SECRET, before, 2), false);
});

test('tampering with any part of the credential fails verification', () => {
  const material = signSessionCredential(SECRET, { token: 'tok-1', accountId: 'acct-1', statusVersion: 1 });
  assert.equal(verifySessionCredential(SECRET, { ...material, token: 'tok-2' }, 1), false);
  assert.equal(verifySessionCredential(SECRET, { ...material, accountId: 'acct-2' }, 1), false);
  assert.equal(verifySessionCredential(SECRET, { ...material, statusVersion: 9 }, 1), false);
  assert.equal(verifySessionCredential(SECRET, { ...material, mac: 'ff'.repeat(32) }, 1), false);
});

test('a mac of the wrong length does not throw', () => {
  const material = signSessionCredential(SECRET, { token: 'tok-1', accountId: 'acct-1', statusVersion: 1 });
  assert.equal(verifySessionCredential(SECRET, { ...material, mac: 'deadbeef' }, 1), false);
});

// ---------------------------------------------------------------------------
// Layer 2
// ---------------------------------------------------------------------------

test('every live connection for the account is closed and counted', () => {
  const registry = new AccountConnectionRegistry();
  const first = new FakeConnection('conn-1');
  const second = new FakeConnection('conn-2');
  const otherAccount = new FakeConnection('conn-3');
  registry.add('acct-1', first);
  registry.add('acct-1', second);
  registry.add('acct-2', otherAccount);

  assert.equal(registry.countFor('acct-1'), 2);
  const closed = registry.revokeAll('acct-1');
  assert.equal(closed, 2);
  assert.deepEqual(first.closed, { code: REVOKE_CLOSE_CODE, reason: 'account frozen' });
  assert.equal(otherAccount.closed, null, 'a different account must be untouched');
  assert.equal(registry.countFor('acct-1'), 0);
});

// ---------------------------------------------------------------------------
// Layer 3
// ---------------------------------------------------------------------------

test('an unreadable store denies rather than allowing', async () => {
  const broken: AccountStore = {
    findById: async () => {
      throw new Error('connection reset');
    },
    freeze: async () => null,
  };
  const authorizer = new ToolCallAuthorizer({ store: broken });
  const decision = await authorizer.authorize('acct-1');
  assert.equal(decision.allowed, false);
  assert.equal(decision.source, 'fail-closed');
  assert.match(decision.reason, /connection reset/);
});

test('a missing account denies rather than allowing', async () => {
  const authorizer = new ToolCallAuthorizer({ store: new FakeStore([]) });
  const decision = await authorizer.authorize('ghost');
  assert.equal(decision.allowed, false);
  assert.equal(decision.source, 'fail-closed');
});

test('cached authorization expires on its own within the bounded window', async () => {
  let now = 1_000_000;
  const clock = { now: () => now };
  const store = new FakeStore([account()]);
  const authorizer = new ToolCallAuthorizer({ store, cacheTtlMs: 5_000, clock });

  const first = await authorizer.authorize('acct-1');
  assert.equal(first.source, 'store');
  assert.equal((await authorizer.authorize('acct-1')).source, 'cache', 'within TTL it should hit cache');

  now += 5_001;
  assert.equal((await authorizer.authorize('acct-1')).source, 'store', 'past TTL it must re-read');
});

test('freeze clears the authorization cache immediately', async () => {
  const store = new FakeStore([account()]);
  const authorizer = new ToolCallAuthorizer({ store, cacheTtlMs: 60_000 });
  assert.equal((await authorizer.authorize('acct-1')).allowed, true);
  assert.equal((await authorizer.authorize('acct-1')).source, 'cache');

  authorizer.invalidate('acct-1');
  const after = await authorizer.authorize('acct-1');
  assert.equal(after.source, 'store', 'invalidation must defeat the TTL cache');
});

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

test('revokeAccess runs all three layers and reports what it did', async () => {
  const store = new FakeStore([account()]);
  const authorizer = new ToolCallAuthorizer({ store, cacheTtlMs: 60_000 });
  const connections = new AccountConnectionRegistry();
  connections.add('acct-1', new FakeConnection('conn-1'));
  connections.add('acct-1', new FakeConnection('conn-2'));

  assert.equal((await authorizer.authorize('acct-1')).allowed, true);
  const report = await revokeAccess('acct-1', { store, authorizer, connections });

  assert.equal(report.statusVersion, 2);
  assert.equal(report.credentialsInvalidated, true);
  assert.equal(report.cacheCleared, true);
  assert.equal(report.connectionsClosed, 2);
  assert.equal((await authorizer.authorize('acct-1')).allowed, false);
});

test('the version is bumped BEFORE connections close (no re-auth gap)', async () => {
  const events: string[] = [];
  const store: AccountStore = {
    findById: async () => account({ status: 'frozen', statusVersion: 2 }),
    freeze: async (id, reason, atMs) => {
      events.push('freeze');
      return new FakeStore([account()]).freeze(id, reason, atMs);
    },
  };
  const authorizer = new ToolCallAuthorizer({ store });
  const registry = new AccountConnectionRegistry();
  registry.add('acct-1', {
    id: 'conn-1',
    close: () => {
      events.push('close');
    },
  });

  await revokeAccess('acct-1', { store, authorizer, connections: registry });
  assert.deepEqual(events, ['freeze', 'close']);
});

test('revoking a nonexistent account still tears down its connections', async () => {
  const authorizer = new ToolCallAuthorizer({ store: new FakeStore([]) });
  const registry = new AccountConnectionRegistry();
  registry.add('ghost', new FakeConnection('conn-9'));
  const report = await revokeAccess('ghost', { store: new FakeStore([]), authorizer, connections: registry });
  assert.equal(report.statusVersion, -1);
  assert.equal(report.connectionsClosed, 1);
});
