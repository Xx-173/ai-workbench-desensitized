import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentControlPlane, FileManifestStore } from '../control-plane.ts';
import { EncryptedFileSecretVault } from '../secret-vault.ts';
import { JsonlUsageLedger } from '../usage-ledger.ts';

const key = Buffer.alloc(32, 7).toString('base64');
const sampleConfig = {
  includeBuiltinAgents: false,
  agents: [{
    id: 'dify-copywriter', toolName: 'generate_copy', description: 'Dify 文案', kind: 'http',
    inputSchema: { type: 'object', properties: { topic: { type: 'string', description: '主题' } }, required: ['topic'] },
    policy: { cost: { inputPerMillion: 1, outputPerMillion: 2, currency: 'USD' }, quota: { maxCallsPerDay: 10 } },
    config: { baseUrlEnv: 'DIFY_BASE_URL', tokenEnv: 'DIFY_API_KEY', path: '/v1/workflows/run', payloadMode: 'dify-workflow' },
  }],
};

test('the encrypted secret vault never writes plaintext and never lists values', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-vault-'));
  try {
    const path = join(dir, 'secrets.enc.json');
    const vault = await EncryptedFileSecretVault.open(path, key);
    await vault.set('DIFY_API_KEY', 'synthetic-secret-value');
    assert.equal(vault.read('DIFY_API_KEY'), 'synthetic-secret-value');
    assert.deepEqual(vault.list().map((item) => item.name), ['DIFY_API_KEY']);
    assert.doesNotMatch(await readFile(path, 'utf8'), /synthetic-secret-value/);
    const reopened = await EncryptedFileSecretVault.open(path, key);
    assert.equal(reopened.read('DIFY_API_KEY'), 'synthetic-secret-value');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Control Center validates manifests, reports missing references and calculates configured usage cost', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-control-'));
  try {
    const manifestStore = new FileManifestStore(join(dir, 'agents.json'));
    const vault = await EncryptedFileSecretVault.open(join(dir, 'secrets.enc.json'), key);
    const usage = new JsonlUsageLedger(join(dir, 'usage.jsonl'));
    const plane = new AgentControlPlane(manifestStore, vault, usage);
    await plane.replaceConfig(sampleConfig);
    const before = await plane.checkAgent('dify-copywriter');
    assert.deepEqual(before.missingReferences, ['DIFY_API_KEY', 'DIFY_BASE_URL']);
    await plane.setSecret('DIFY_API_KEY', 'synthetic-token');
    await plane.setSecret('DIFY_BASE_URL', 'https://dify.example.invalid');
    assert.equal((await plane.checkAgent('dify-copywriter')).status, 'configured');
    await usage.record({
      agentId: 'dify-copywriter', kind: 'http', occurredAt: new Date().toISOString(), durationMs: 10,
      status: 'success', inputBytes: 2, outputBytes: 3, inputTokens: 500_000, outputTokens: 250_000,
    });
    const dashboard = await plane.dashboard();
    assert.equal(dashboard.configuredSecrets, 2);
    assert.equal(dashboard.usage[0]?.estimatedCost, 1);
    assert.equal(dashboard.usage[0]?.currency, 'USD');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
