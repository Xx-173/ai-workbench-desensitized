/**
 * Tests for the transport entry point.
 *
 * These cover the deterministic parts — argument parsing, host context
 * construction, and the advertised tool list. Booting the stdio server itself
 * is a manual smoke test (see README) because a subprocess under `node --test`
 * is slow and flaky for what it buys.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  advertisedTools,
  createHostContext,
  credentialsFromEnv,
  parseArgs,
} from './mcp-server.ts';

test('parseArgs requires both session id and workspace root', () => {
  const config = parseArgs(['--session-id', 's1', '--workspace-root', '/tmp/ws']);
  assert.deepEqual(config, { sessionId: 's1', workspaceRootPath: '/tmp/ws' });
  assert.throws(() => parseArgs(['--session-id', 's1']), /required/);
  assert.throws(() => parseArgs([]), /required/);
});

test('parseArgs keeps Control Center manifest and vault options explicit', () => {
  const config = parseArgs(['--session-id', 's1', '--workspace-root', '/tmp/ws', '--agents-config', '/tmp/agents.json', '--secret-store', '/tmp/secrets.enc.json', '--master-key-env', 'TEST_MASTER_KEY']);
  assert.equal(config.agentsConfigPath, '/tmp/agents.json');
  assert.equal(config.secretStorePath, '/tmp/secrets.enc.json');
  assert.equal(config.masterKeyEnv, 'TEST_MASTER_KEY');
});

test('the host context matches the base SessionToolContext slice', () => {
  const host = createHostContext({ sessionId: 's1', workspaceRootPath: '/tmp/ws' });
  assert.equal(host.sessionId, 's1');
  assert.equal(host.workspacePath, '/tmp/ws');
  assert.equal(typeof host.fs.exists, 'function');
  assert.equal(typeof host.fs.readFile, 'function');
  assert.equal(typeof host.fs.writeFile, 'function');
  assert.equal(typeof host.fs.readdir, 'function');
});

test('a missing source config reads as null instead of throwing', () => {
  const host = createHostContext({ sessionId: 's1', workspaceRootPath: '/tmp/ws' });
  assert.equal(host.loadSourceConfig?.('no-such-source'), null);
});

test('env credentials expose only what is configured', () => {
  const reader = credentialsFromEnv({
    VOICE_SERVICE_TOKEN: 'placeholder-value',
  } as unknown as NodeJS.ProcessEnv);
  assert.equal(reader.read('VOICE_SERVICE_TOKEN'), 'placeholder-value');
  assert.equal(reader.read('VIDEO_PARSE_TOKEN'), null);
});

test('the server advertises all five capabilities with schemas', () => {
  const tools = advertisedTools();
  assert.equal(tools.length, 5);
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['clean_script', 'clone_voice', 'generate_copy', 'parse_video', 'qc_text']);
  for (const tool of tools) {
    assert.equal((tool.inputSchema as { type: string }).type, 'object');
    assert.ok(Object.keys(tool.inputSchema as object).length > 0);
  }
});
