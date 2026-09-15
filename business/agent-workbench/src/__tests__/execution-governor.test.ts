import test from 'node:test';
import assert from 'node:assert/strict';

import { ExecutionGovernor } from '../execution-governor.ts';
import type { AgentManifest } from '../agent-manifest.ts';
import { InMemoryUsageLedger } from '../usage-ledger.ts';

const manifest: AgentManifest = {
  id: 'quota-agent', toolName: 'quota_tool', description: '配额测试', kind: 'python',
  inputSchema: { type: 'object', properties: {} },
  policy: { quota: { maxCallsPerDay: 1, maxTokensPerDay: 100 } },
  config: { command: 'python' },
};

test('daily call and token quotas use durable usage-reader facts', async () => {
  const usage = new InMemoryUsageLedger();
  const now = Date.now();
  usage.record({ agentId: 'quota-agent', kind: 'python', occurredAt: new Date(now).toISOString(), durationMs: 1, status: 'success', inputBytes: 0, outputBytes: 0, inputTokens: 60, outputTokens: 50 });
  const governor = new ExecutionGovernor({ usageReader: usage, clock: { now: () => now } });
  await assert.rejects(() => governor.acquire(manifest), /Daily calls quota exceeded/);
  const tokenOnly: AgentManifest = { ...manifest, policy: { quota: { maxTokensPerDay: 100 } } };
  await assert.rejects(() => governor.acquire(tokenOnly), /Daily tokens quota exceeded/);
});
