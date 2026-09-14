import test from 'node:test';
import assert from 'node:assert/strict';

import { CapabilityRegistry, UnknownCapabilityError, validateInput } from '../capability-registry.ts';
import { capabilities } from '../capabilities.ts';
import { createWorkbenchRegistry } from '../index.ts';
import { fakeCredentials, emptyCredentials, fakeFetch, withTempWorkspace } from './fixtures.ts';

test('registry exposes one tool definition per declared capability', () => {
  const registry = createWorkbenchRegistry();
  const defs = registry.listToolDefinitions();
  assert.equal(defs.length, capabilities.length);
  for (const def of defs) {
    assert.match(def.name, /^[a-z_]+$/);
    assert.ok(def.description.length > 0);
  }
});

test('adding a capability touches only the registration list', () => {
  const registry = new CapabilityRegistry();
  registry.register({
    id: 'sample-only',
    toolName: 'sample_tool',
    description: '只在测试里存在的占位能力',
    transport: 'in-process',
    inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'x' } }, required: ['text'] },
    invoke: async (_ctx, input) => ({ summary: String(input.text) }),
  });
  assert.ok(registry.has('sample-only'));
  assert.equal(registry.listToolDefinitions().length, 1);
});

test('duplicate registration is rejected rather than silently overwritten', () => {
  const registry = new CapabilityRegistry();
  const base = {
    id: 'dup',
    toolName: 'dup_tool',
    description: '',
    transport: 'in-process' as const,
    inputSchema: { type: 'object' as const, properties: {} },
    invoke: async () => ({ summary: 'ok' }),
  };
  registry.register(base);
  assert.throws(() => registry.register(base), /already registered/);
});

test('unknown capability raises a typed error, not a generic one', async () => {
  const registry = createWorkbenchRegistry();
  await assert.rejects(
    () => registry.invoke('does-not-exist', { sessionId: 's', workspacePath: '.', credentials: fakeCredentials() }, {}),
    UnknownCapabilityError,
  );
});

test('input validation rejects missing required fields', async () => {
  const registry = createWorkbenchRegistry();
  const result = await registry.invokeAsTool(
    'copywriting',
    { sessionId: 's', workspacePath: '.', credentials: fakeCredentials() },
    { topic: '缺少受众' } as never,
  );
  assert.equal(result.isError, true);
  assert.match(result.content, /required/);
});

test('validateInput catches wrong scalar and wrong array item types', () => {
  const schema = {
    type: 'object' as const,
    properties: {
      count: { type: 'number' as const, description: 'n' },
      tags: { type: 'array' as const, description: 't', items: { type: 'string' as const } },
    },
  };
  assert.throws(() => validateInput(schema, { count: 'not-a-number' }), /expected number/);
  assert.throws(() => validateInput(schema, { tags: [1, 2] }), /items must be string/);
  assert.doesNotThrow(() => validateInput(schema, { count: 1, tags: ['a'] }));
});

test('unconfigured services fail loudly naming the placeholder — never default', async () => {
  await withTempWorkspace(async (dir) => {
    const registry = createWorkbenchRegistry();
    const result = await registry.invokeAsTool(
      'voice-clone',
      { sessionId: 'session-1', workspacePath: dir, credentials: emptyCredentials },
      { referenceAudio: 'reference.wav', targetText: '示例文本' },
    );
    assert.equal(result.isError, true);
    assert.match(result.content, /VOICE_SERVICE_BASE_URL/);
  });
});

test('a configured capability runs end to end and writes into the task outputs', async () => {
  await withTempWorkspace(async (dir) => {
    setFetchImplForTest({
      '/v1/voices/clone': { audio_ref: 'placeholder-audio-ref' },
    });
    try {
      const registry = createWorkbenchRegistry();
      const result = await registry.invokeAsTool(
        'voice-clone',
        { sessionId: 'session-1', workspacePath: dir, credentials: fakeCredentials() },
        { referenceAudio: 'reference.wav', targetText: '示例文本' },
      );
      assert.equal(result.isError, false, result.content);
      const { existsSync, readFileSync } = await import('node:fs');
      const artifact = `${dir}/tasks/session-1/outputs/voice-clone.json`;
      assert.ok(existsSync(artifact), `expected artifact at ${artifact}`);
      assert.match(readFileSync(artifact, 'utf8'), /placeholder-audio-ref/);
    } finally {
      resetFetchImplForTest();
    }
  });
});

// ---------------------------------------------------------------------------

import { setFetchImpl, resetFetchImpl } from '../capabilities.ts';

function setFetchImplForTest(routes: Readonly<Record<string, unknown>>) {
  const harness = fakeFetch({ routes });
  setFetchImpl(harness.fetch as never);
  return harness;
}

function resetFetchImplForTest() {
  resetFetchImpl();
}
