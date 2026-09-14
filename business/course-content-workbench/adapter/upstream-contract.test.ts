/**
 * Guard test — the reason structural typing is safe here.
 *
 * Because this layer accepts a *shape* instead of importing the base class, a
 * rename upstream (say `workspacePath` → `rootPath`) would not break the
 * compile step; it would just silently hand `undefined` to the business layer.
 * This test reads the real upstream source and fails loudly instead.
 *
 * It is deliberately a source-text check: it runs without installing anything,
 * which is the whole point of keeping this layer outside the workspace graph.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(here, '..', '..', '..');

const upstreamContext = join(repoRoot, 'packages', 'session-tools-core', 'src', 'context.ts');
const upstreamMessageTypes = join(repoRoot, 'packages', 'core', 'src', 'types', 'message.ts');

function readUpstream(path: string): string {
  return readFileSync(path, 'utf8');
}

test('upstream SessionToolContext still declares the members this layer reads', () => {
  const src = readUpstream(upstreamContext);
  const start = src.indexOf('export interface SessionToolContext {');
  assert.notEqual(start, -1, 'SessionToolContext not found — upstream was restructured');
  const body = src.slice(start, src.indexOf('\n}', start));

  for (const member of ['sessionId: string;', 'workspacePath: string;', 'fs: FileSystemInterface;', 'callbacks: SessionToolCallbacks;']) {
    assert.ok(body.includes(member), `missing member "${member}" in upstream SessionToolContext`);
  }
  assert.ok(body.includes('credentialManager?'), 'credentialManager must remain optional');
});

test('upstream FileSystemInterface still matches the slice we depend on', () => {
  const src = readUpstream(upstreamContext);
  const start = src.indexOf('export interface FileSystemInterface {');
  assert.notEqual(start, -1);
  const body = src.slice(start, src.indexOf('\n}', start));
  for (const method of ['exists(path: string)', 'readFile(path: string)', 'writeFile(path: string, content: string)', 'readdir(path: string)']) {
    assert.ok(body.includes(method), `missing fs method "${method}"`);
  }
});

test('upstream CredentialManagerInterface getToken signature is unchanged', () => {
  const src = readUpstream(upstreamContext);
  const start = src.indexOf('export interface CredentialManagerInterface {');
  assert.notEqual(start, -1);
  const body = src.slice(start, src.indexOf('\n}', start));
  assert.ok(/getToken\(source: LoadedSource\): Promise<string \| null>;/.test(body), 'getToken signature changed');
});

test('the AgentEvent union still contains every member this layer emits', () => {
  const src = readUpstream(upstreamMessageTypes);
  const start = src.indexOf('export type AgentEvent =');
  assert.notEqual(start, -1, 'AgentEvent union not found');
  const body = src.slice(start, src.indexOf('\n}', start + src.slice(start).indexOf('|')));

  const emitted = ['status', 'text_delta', 'tool_start', 'tool_result', 'error', 'complete'];
  for (const member of emitted) {
    assert.ok(body.includes(`type: '${member}'`), `AgentEvent no longer has member "${member}"`);
  }
});

test('the documented pi_turn_anchor leak is still real (keeps the narrative honest)', () => {
  const src = readUpstream(upstreamMessageTypes);
  const start = src.indexOf('export type AgentEvent =');
  const body = src.slice(start, src.indexOf('\n}', start + src.slice(start).indexOf('|')));
  assert.ok(body.includes("type: 'pi_turn_anchor'"), 'the backend-specific member is gone — update the resume talking point');
});
