import test from 'node:test';
import assert from 'node:assert/strict';

import { collectCredentialReferenceNames, parseAgentWorkbenchConfig, type AgentManifest } from '../agent-manifest.ts';
import { createWorkbenchRegistry } from '../index.ts';
import { InMemoryCaseMemory } from '../case-memory.ts';
import { InMemoryUsageLedger } from '../usage-ledger.ts';
import { fakeCredentials, fakeFetch } from './fixtures.ts';

const httpAgent: AgentManifest = {
  id: 'copywriter-dify',
  toolName: 'generate_copy',
  description: 'Dify 文案 Agent',
  kind: 'http',
  inputSchema: {
    type: 'object',
    properties: { topic: { type: 'string', description: '主题' } },
    required: ['topic'],
  },
  timeoutMs: 30_000,
  config: {
    baseUrlEnv: 'DIFY_BASE_URL',
    tokenEnv: 'DIFY_API_KEY',
    path: '/v1/workflows/run',
    payloadMode: 'dify-workflow',
  },
};

test('an HTTP workflow agent is registered from a manifest and receives host-resolved configuration', async () => {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const harness = fakeFetch({ routes: { '/v1/workflows/run': { data: { text: 'synthetic' }, usage: { prompt_tokens: 3, completion_tokens: 5 } } }, calls });
  const usage = new InMemoryUsageLedger();
  const ticks = [100, 145, 145];
  const registry = createWorkbenchRegistry({
    includeBuiltinAgents: false,
    agents: [httpAgent],
    runtime: { fetchImpl: harness.fetch as never, usageRecorder: usage, clock: { now: () => ticks.shift() ?? 145 } },
  });
  const result = await registry.invoke(
    'copywriter-dify',
    { sessionId: 's', workspacePath: '.', credentials: fakeCredentials({ DIFY_BASE_URL: 'https://dify.example.invalid', DIFY_API_KEY: 'DIFY_TOKEN' }) },
    { topic: 'synthetic topic' },
  );
  assert.equal(result.summary, 'Agent copywriter-dify completed');
  assert.deepEqual(calls[0]?.body, { inputs: { topic: 'synthetic topic' }, response_mode: 'blocking', user: 'agent-workbench' });
  assert.equal(usage.list().length, 1);
  assert.deepEqual(usage.list()[0], {
    agentId: 'copywriter-dify', kind: 'http', occurredAt: new Date(145).toISOString(), durationMs: 45,
    status: 'success', inputBytes: Buffer.byteLength('{"topic":"synthetic topic"}'),
    outputBytes: Buffer.byteLength(JSON.stringify({ data: { text: 'synthetic' }, usage: { prompt_tokens: 3, completion_tokens: 5 } })),
    inputTokens: 3, outputTokens: 5,
  });
});

test('a Python agent gets only its declared host credential aliases', async () => {
  const agent: AgentManifest = {
    id: 'script-cleaner', toolName: 'clean_script', description: 'Python 清洗 Agent', kind: 'python',
    credentials: [{ name: 'LLM_API_KEY', source: 'CLEANER_LLM_KEY' }],
    inputSchema: { type: 'object', properties: { text: { type: 'string', description: '文本' } }, required: ['text'] },
    config: { command: 'python', args: ['clean.py'] },
  };
  let received: Record<string, string> | undefined;
  const registry = createWorkbenchRegistry({
    includeBuiltinAgents: false,
    agents: [agent],
    runtime: {
      executePython: async (request) => {
        received = { ...request.credentials };
        return { cleaned: String(request.input.text) };
      },
    },
  });
  const result = await registry.invoke(
    'script-cleaner',
    { sessionId: 's', workspacePath: '.', credentials: fakeCredentials({ CLEANER_LLM_KEY: 'synthetic-key' }) },
    { text: 'hello' },
  );
  assert.deepEqual(received, { LLM_API_KEY: 'synthetic-key' });
  assert.deepEqual(result.raw, { cleaned: 'hello' });
});

test('missing configuration is surfaced instead of routing an agent to a default endpoint', async () => {
  const registry = createWorkbenchRegistry({ includeBuiltinAgents: false, agents: [httpAgent] });
  await assert.rejects(
    () => registry.invoke('copywriter-dify', { sessionId: 's', workspacePath: '.', credentials: fakeCredentials({ DIFY_BASE_URL: null, DIFY_API_KEY: null }) }, { topic: 'x' }),
    /DIFY_BASE_URL/,
  );
});

test('a configured retry policy retries a transient agent failure once and records the final attempt count', async () => {
  const agent: AgentManifest = {
    id: 'retry-cleaner', toolName: 'retry_cleaner', description: '重试样例', kind: 'python',
    policy: { retry: { maxAttempts: 2, backoffMs: 0 } },
    inputSchema: { type: 'object', properties: {}, }, config: { command: 'python' },
  };
  const usage = new InMemoryUsageLedger();
  let calls = 0;
  const registry = createWorkbenchRegistry({
    includeBuiltinAgents: false, agents: [agent], runtime: {
      usageRecorder: usage,
      executePython: async () => {
        calls += 1;
        if (calls === 1) throw new Error('temporary failure');
        return { ok: true };
      },
    },
  });
  await registry.invoke('retry-cleaner', { sessionId: 's', workspacePath: '.', credentials: fakeCredentials() }, {});
  assert.equal(calls, 2);
  assert.equal(usage.list()[0]?.attempts, 2);
  assert.equal(usage.list()[0]?.status, 'success');
});

test('runtime writes content-free success and failure cases without changing invocation results', async () => {
  const memory = new InMemoryCaseMemory();
  const registry = createWorkbenchRegistry({
    includeBuiltinAgents: false, agents: [httpAgent], runtime: {
      caseMemory: memory,
      fetchImpl: fakeFetch({ routes: { '/v1/workflows/run': { ok: true } } }).fetch as never,
    },
  });
  await registry.invoke('copywriter-dify', {
    sessionId: 's', workspacePath: '.', credentials: fakeCredentials({ DIFY_BASE_URL: 'https://dify.example.invalid', DIFY_API_KEY: 'synthetic' }),
  }, { topic: 'private phrase' });
  const success = memory.list()[0];
  assert.equal(success?.outcome, 'success');
  assert.equal(success?.strategy, 'cache-successful-invocation-metadata');
  assert.equal(success?.inputFingerprint.length, 64);

  const failing = createWorkbenchRegistry({ includeBuiltinAgents: false, agents: [httpAgent], runtime: { caseMemory: memory } });
  await assert.rejects(
    () => failing.invoke('copywriter-dify', { sessionId: 's', workspacePath: '.', credentials: fakeCredentials({ DIFY_BASE_URL: null, DIFY_API_KEY: null }) }, { topic: 'private phrase' }),
  );
  const failure = memory.list()[1];
  assert.equal(failure?.outcome, 'failure');
  assert.equal(failure?.failureCategory, 'missing-configuration');
  assert.equal(failure?.strategy, 'request-admin-configure-credential');
});

test('a configured sliding window rate limit blocks a second invocation', async () => {
  const agent: AgentManifest = {
    id: 'limited', toolName: 'limited_tool', description: '限流样例', kind: 'python',
    policy: { rateLimit: { maxRequests: 1, windowMs: 10_000 } },
    inputSchema: { type: 'object', properties: {} }, config: { command: 'python' },
  };
  const registry = createWorkbenchRegistry({
    includeBuiltinAgents: false, agents: [agent], runtime: { executePython: async () => ({ ok: true }) },
  });
  const context = { sessionId: 's', workspacePath: '.', credentials: fakeCredentials() };
  await registry.invoke('limited', context, {});
  await assert.rejects(() => registry.invoke('limited', context, {}), /Rate limit exceeded/);
});

test('the parser accepts generic HTTP, Python and MCP manifests but rejects duplicate tool names', () => {
  const parsed = parseAgentWorkbenchConfig({
    includeBuiltinAgents: false,
    agents: [
      { id: 'a', toolName: 'a_tool', description: 'A', kind: 'http', policy: { retry: { maxAttempts: 2, backoffMs: 0 }, rateLimit: { maxRequests: 3, windowMs: 1000 }, quota: { maxCallsPerDay: 10 }, cost: { inputPerMillion: 1, currency: 'USD' } }, inputSchema: { type: 'object', properties: {} }, config: { baseUrlEnv: 'A_BASE_URL', path: '/run' } },
      { id: 'b', toolName: 'b_tool', description: 'B', kind: 'python', inputSchema: { type: 'object', properties: {} }, config: { command: 'python' } },
      { id: 'c', toolName: 'c_tool', description: 'C', kind: 'mcp', inputSchema: { type: 'object', properties: {} }, config: { command: 'node', toolName: 'run_task' } },
    ],
  });
  assert.equal(parsed.agents.length, 3);
  assert.equal(parsed.agents[2]?.kind, 'mcp');
  assert.equal(parsed.agents[0]?.policy?.rateLimit?.maxRequests, 3);
  assert.deepEqual(collectCredentialReferenceNames([httpAgent, {
    id: 'cleaner', toolName: 'cleaner_tool', description: 'x', kind: 'python',
    credentials: [{ name: 'TOKEN', source: 'CLEANER_TOKEN' }],
    inputSchema: { type: 'object', properties: {} }, config: { command: 'python' },
  }]), ['CLEANER_TOKEN', 'DIFY_API_KEY', 'DIFY_BASE_URL']);
  assert.throws(
    () => parseAgentWorkbenchConfig({ agents: [
      { id: 'a', toolName: 'same_tool', description: 'A', kind: 'python', inputSchema: { type: 'object', properties: {} }, config: { command: 'python' } },
      { id: 'b', toolName: 'same_tool', description: 'B', kind: 'python', inputSchema: { type: 'object', properties: {} }, config: { command: 'python' } },
    ] }),
    /duplicate toolName/,
  );
});
