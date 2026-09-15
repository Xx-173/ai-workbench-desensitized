import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InMemoryUsageLedger, JsonlUsageLedger } from '../usage-ledger.ts';

const first = {
  agentId: 'copywriter', kind: 'http' as const, occurredAt: '2026-01-01T00:00:00.000Z', durationMs: 12,
  status: 'success' as const, inputBytes: 10, outputBytes: 20, inputTokens: 2, outputTokens: 3,
};

test('the in-memory summary aggregates operations without retaining content', () => {
  const ledger = new InMemoryUsageLedger();
  ledger.record(first);
  ledger.record({ ...first, status: 'error', durationMs: 8, inputBytes: 5, outputBytes: 0 });
  assert.deepEqual(ledger.summarize(), [{
    agentId: 'copywriter', calls: 2, successes: 1, failures: 1, durationMs: 20,
    inputBytes: 15, outputBytes: 20, inputTokens: 4, outputTokens: 6,
  }]);
  assert.equal(Object.hasOwn(ledger.list()[0]!, 'prompt'), false);
  assert.equal(Object.hasOwn(ledger.list()[0]!, 'output'), false);
});

test('the JSONL ledger reopens a durable aggregate-safe usage history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-usage-'));
  try {
    const ledger = new JsonlUsageLedger(join(dir, 'usage.jsonl'));
    await ledger.record(first);
    assert.deepEqual(await ledger.summarize(), [{
      agentId: 'copywriter', calls: 1, successes: 1, failures: 0, durationMs: 12,
      inputBytes: 10, outputBytes: 20, inputTokens: 2, outputTokens: 3,
    }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
