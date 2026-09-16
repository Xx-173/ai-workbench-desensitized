/**
 * Opt-in real Dify sandbox check. This never runs in normal CI: it needs a
 * deployment-owned endpoint/key and emits only redacted connectivity metadata.
 */

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { createWorkbenchRegistry } from '../src/index.ts';

const baseUrl = process.env.DIFY_BASE_URL;
const apiKey = process.env.DIFY_API_KEY;
if (!baseUrl || !apiKey) {
  throw new Error('Set DIFY_BASE_URL and DIFY_API_KEY before running the opt-in sandbox check.');
}

const inputRaw = process.env.DIFY_SANDBOX_INPUT ?? '{"topic":"sandbox connectivity check"}';
let input: Record<string, unknown>;
try {
  const parsed = JSON.parse(inputRaw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
  input = parsed as Record<string, unknown>;
} catch {
  throw new Error('DIFY_SANDBOX_INPUT must be a JSON object matching your Dify workflow inputs.');
}

const outputFlag = process.argv.indexOf('--out');
const output = resolve(outputFlag >= 0 && process.argv[outputFlag + 1] ? process.argv[outputFlag + 1]! : 'artifacts/dify-sandbox-check.json');
const startedAt = Date.now();
const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
const credentialReader = { read: (name: string) => name === 'DIFY_BASE_URL' ? baseUrl : name === 'DIFY_API_KEY' ? apiKey : null };

try {
  const registry = createWorkbenchRegistry({
    includeBuiltinAgents: false,
    agents: [{
      id: 'dify-sandbox', toolName: 'dify_sandbox', description: 'Deployment-owned Dify sandbox verification', kind: 'http',
      inputSchema: { type: 'object', properties: {} },
      config: { baseUrlEnv: 'DIFY_BASE_URL', tokenEnv: 'DIFY_API_KEY', path: '/v1/workflows/run', payloadMode: 'dify-workflow' },
    }],
  });
  const result = await registry.invoke('dify-sandbox', { sessionId: 'sandbox', workspacePath: '.', credentials: credentialReader }, input as never);
  const outputBytes = Buffer.byteLength(JSON.stringify(result.raw ?? null));
  const topLevelKeys = result.raw && typeof result.raw === 'object' && !Array.isArray(result.raw) ? Object.keys(result.raw).sort().slice(0, 20) : [];
  const artifact = { status: 'success', agent: 'dify-sandbox', durationMs: Date.now() - startedAt, inputFingerprint: fingerprint, outputBytes, topLevelKeys };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  console.log(`Dify sandbox verified; redacted artifact written to ${output}`);
} catch {
  const artifact = { status: 'failure', agent: 'dify-sandbox', durationMs: Date.now() - startedAt, inputFingerprint: fingerprint, failureCategory: 'upstream-or-workflow-error' };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  console.error(`Dify sandbox did not verify; redacted artifact written to ${output}`);
  process.exitCode = 1;
}
