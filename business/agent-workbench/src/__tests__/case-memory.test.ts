import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createCaseMemoryEntry, InMemoryCaseMemory, JsonlCaseMemory } from '../case-memory.ts';
import { withTempWorkspace } from './fixtures.ts';

test('case memory fingerprints inputs but never persists input or output text', async () => {
  await withTempWorkspace(async (dir) => {
    const path = join(dir, 'case-memory.jsonl');
    const memory = new JsonlCaseMemory(path);
    const entry = createCaseMemoryEntry({
      agentId: 'copywriter', occurredAt: '2026-01-01T00:00:00.000Z', outcome: 'success', input: { prompt: 'private customer phrase' },
      inputBytes: 35, outputBytes: 20, durationMs: 12, attempts: 1, strategy: 'cache-successful-invocation-metadata',
    });
    await memory.record(entry);
    const raw = await readFile(path, 'utf8');
    assert.doesNotMatch(raw, /private customer phrase/);
    assert.equal((await memory.list())[0]?.inputFingerprint.length, 64);
  });
});

test('in-memory case cache identifies a previous success by redacted fingerprint', () => {
  const memory = new InMemoryCaseMemory();
  memory.record(createCaseMemoryEntry({
    agentId: 'cleaner', occurredAt: '2026-01-01T00:00:00.000Z', outcome: 'success', input: { text: 'same' },
    inputBytes: 15, outputBytes: 10, durationMs: 1, attempts: 1, strategy: 'cache-successful-invocation-metadata',
  }));
  assert.ok(memory.recentSuccess('cleaner', { text: 'same' }));
  assert.equal(memory.recentSuccess('cleaner', { text: 'different' }), undefined);
});
