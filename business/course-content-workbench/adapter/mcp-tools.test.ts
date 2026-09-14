import test from 'node:test';
import assert from 'node:assert/strict';

import { errorResult, listCapabilityTools, callCapabilityTool, textResult } from './mcp-tools.ts';
import { createWorkbenchRegistry } from '../src/index.ts';
import { setFetchImpl, resetFetchImpl } from '../src/capabilities.ts';
import { emptyCredentials, fakeCredentials, fakeFetch, withTempWorkspace } from '../src/__tests__/fixtures.ts';
import type { CapabilityRegistry } from '../src/capability-registry.ts';

function resolverFor(registry: CapabilityRegistry) {
  return { idForToolName: (toolName: string) => registry.idForToolName(toolName) };
}

test('tools/list advertises every registered capability', () => {
  const registry = createWorkbenchRegistry();
  const tools = listCapabilityTools(registry);
  assert.equal(tools.length, 5);
  for (const tool of tools) {
    assert.ok(tool.name.length > 0);
    assert.ok(tool.description.length > 0);
    assert.equal((tool.inputSchema as { type: string }).type, 'object');
  }
});

test('an unknown tool name is an isError result, not a thrown exception', async () => {
  const registry = createWorkbenchRegistry();
  const result = await callCapabilityTool(
    registry,
    resolverFor(registry),
    { sessionId: 's', workspacePath: '.', credentials: fakeCredentials() },
    'no_such_tool',
    {},
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /Unknown tool/);
});

test('misconfiguration surfaces over the wire naming the placeholder', async () => {
  const registry = createWorkbenchRegistry();
  const result = await callCapabilityTool(
    registry,
    resolverFor(registry),
    { sessionId: 's', workspacePath: '.', credentials: emptyCredentials },
    'clone_voice',
    { referenceAudio: 'a.wav', targetText: 'x' },
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /VOICE_SERVICE_BASE_URL/);
});

test('the same registry serves MCP successfully end to end', async () => {
  await withTempWorkspace(async (dir) => {
    const harness = fakeFetch({ routes: { '/v1/voices/clone': { audio_ref: 'placeholder-audio-ref' } } });
    setFetchImpl(harness.fetch as never);
    try {
      const registry = createWorkbenchRegistry();
      const result = await callCapabilityTool(
        registry,
        resolverFor(registry),
        { sessionId: 'session-1', workspacePath: dir, credentials: fakeCredentials() },
        'clone_voice',
        { referenceAudio: 'a.wav', targetText: 'x' },
      );
      assert.equal(result.isError, false, result.content[0]!.text);
      assert.match(result.content[0]!.text, /placeholder-audio-ref/);
    } finally {
      resetFetchImpl();
    }
  });
});

test('error and success envelopes have the documented shape', () => {
  assert.deepEqual(textResult('x'), { content: [{ type: 'text', text: 'x' }], isError: false });
  assert.deepEqual(errorResult('x'), { content: [{ type: 'text', text: 'x' }], isError: true });
});
