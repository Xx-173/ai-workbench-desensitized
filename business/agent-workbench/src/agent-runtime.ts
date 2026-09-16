/**
 * Generic runtime for externally implemented agents.
 *
 * The host owns credential lookup and accounting. Individual integrations only
 * receive the credentials explicitly referenced in their approved manifest.
 */

import { spawn } from 'node:child_process';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import type { CapabilityEntry, CapabilityInvocationResult } from './capability-registry.ts';
import type { AgentManifest, CredentialBinding, HttpAgentConfig, McpAgentConfig, PythonAgentConfig } from './agent-manifest.ts';
import type { Clock, JsonObject, JsonValue, ToolContext } from './ports.ts';
import { systemClock } from './ports.ts';
import { joinUrl, type FetchLike, MisconfiguredError } from './remote.ts';
import { ExecutionGovernor, retryDelayMs } from './execution-governor.ts';
import type { AgentUsageEvent, UsageReader, UsageRecorder } from './usage-ledger.ts';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_PROCESS_OUTPUT_BYTES = 1_000_000;

export interface AgentExecutionRequest {
  readonly manifest: AgentManifest;
  readonly input: JsonObject;
  readonly ctx: ToolContext;
  /** Only the manifest's declared bindings; never the whole process environment. */
  readonly credentials: Readonly<Record<string, string>>;
}

export type AgentExecutor = (request: AgentExecutionRequest) => Promise<JsonValue>;

export interface AgentRuntimeDependencies {
  readonly fetchImpl?: FetchLike;
  readonly executePython?: AgentExecutor;
  readonly executeMcp?: AgentExecutor;
  readonly usageRecorder?: UsageRecorder;
  readonly usageReader?: UsageReader;
  /** Supply one shared governor when creating registries repeatedly. */
  readonly governor?: ExecutionGovernor;
  readonly clock?: Clock;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return typeof value === 'object' && Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function jsonByteLength(value: JsonValue): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function extractUsage(value: JsonValue): Pick<AgentUsageEvent, 'inputTokens' | 'outputTokens'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const payload = value as Record<string, unknown>;
  const usage = (payload.usage ?? (payload.metadata as Record<string, unknown> | undefined)?.usage) as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== 'object') return {};
  const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens
    : typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined;
  const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens
    : typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined;
  return { ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }) };
}

function credentialsFor(ctx: ToolContext, bindings: readonly CredentialBinding[] | undefined): Readonly<Record<string, string>> {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const binding of bindings ?? []) {
    const value = ctx.credentials.read(binding.source);
    if (!value) missing.push(binding.source);
    else values[binding.name] = value;
  }
  if (missing.length > 0) throw new MisconfiguredError(missing);
  return values;
}

function requireCredential(ctx: ToolContext, name: string): string {
  const value = ctx.credentials.read(name);
  if (!value) throw new MisconfiguredError([name]);
  return value;
}

function buildHttpBody(config: HttpAgentConfig, input: JsonObject): JsonObject {
  const common = config.staticBody ?? {};
  if (config.payloadMode === 'dify-workflow') {
    return { ...common, inputs: input, response_mode: 'blocking', user: 'agent-workbench' };
  }
  if (config.payloadMode === 'coze-workflow') return { ...common, parameters: input };
  return { ...common, ...input };
}

async function executeHttp(manifest: AgentManifest, ctx: ToolContext, input: JsonObject, fetchImpl: FetchLike): Promise<JsonValue> {
  const config = manifest.config as HttpAgentConfig;
  const baseUrl = requireCredential(ctx, config.baseUrlEnv);
  const token = config.tokenEnv ? requireCredential(ctx, config.tokenEnv) : undefined;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers[config.tokenHeader ?? 'authorization'] = `${config.tokenPrefix ?? 'Bearer'} ${token}`.trim();
  const response = await fetchImpl(joinUrl(baseUrl, config.path), {
    method: 'POST', headers, body: JSON.stringify(buildHttpBody(config, input)),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Upstream ${response.status}: ${detail.slice(0, 200)}`);
  }
  const payload = await response.json();
  if (!isJsonValue(payload)) throw new Error(`Agent ${manifest.id} returned a non-JSON value`);
  return payload;
}

function safeChildEnvironment(credentials: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'COMSPEC', 'TEMP', 'TMP']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return { ...env, ...credentials };
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

async function executeJsonProcess(config: PythonAgentConfig, request: AgentExecutionRequest): Promise<JsonValue> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.command, [...(config.args ?? [])], {
      shell: false,
      windowsHide: true,
      env: safeChildEnvironment(request.credentials),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, request.manifest.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const append = (target: 'stdout' | 'stderr', chunk: Buffer | string) => {
      const next = `${target === 'stdout' ? stdout : stderr}${String(chunk)}`;
      if (next.length > MAX_PROCESS_OUTPUT_BYTES) {
        child.kill();
        reject(new Error(`Agent ${request.manifest.id} exceeded process output limit`));
        return;
      }
      if (target === 'stdout') stdout = next;
      else stderr = next;
    };
    child.stdout.on('data', (chunk) => append('stdout', chunk));
    child.stderr.on('data', (chunk) => append('stderr', chunk));
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (timedOut) return reject(new Error(`Agent ${request.manifest.id} timed out`));
      if (code !== 0) return reject(new Error(`Agent ${request.manifest.id} exited ${code}: ${stderr.slice(0, 200)}`));
      try {
        const output = JSON.parse(stdout) as unknown;
        if (!isJsonValue(output)) throw new Error('non-JSON output');
        resolve(output);
      } catch {
        reject(new Error(`Agent ${request.manifest.id} must emit one JSON value on stdout`));
      }
    });
    child.stdin.end(JSON.stringify(request.input));
  });
}

async function executeMcp(config: McpAgentConfig, request: AgentExecutionRequest): Promise<JsonValue> {
  const transport = new StdioClientTransport({
    command: config.command,
    args: [...(config.args ?? [])],
    env: safeChildEnvironment(request.credentials) as Record<string, string>,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'agent-workbench', version: '0.1.0' });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: config.toolName, arguments: request.input });
    if (!isJsonValue(result)) throw new Error(`Agent ${request.manifest.id} returned a non-JSON MCP result`);
    return result;
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** Converts one admin-approved manifest into the existing registry contract. */
export function createAgentEntries(
  manifests: readonly AgentManifest[],
  dependencies: AgentRuntimeDependencies = {},
): readonly CapabilityEntry[] {
  const clock = dependencies.clock ?? systemClock;
  const fetchImpl = dependencies.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const governor = dependencies.governor ?? new ExecutionGovernor({ clock, usageReader: dependencies.usageReader });
  return manifests.map((manifest) => ({
    id: manifest.id,
    toolName: manifest.toolName,
    description: manifest.description,
    inputSchema: manifest.inputSchema,
    transport: 'mcp' as const,
    async invoke(ctx, input): Promise<CapabilityInvocationResult> {
      const startedAt = clock.now();
      let output: JsonValue | undefined;
      let error: unknown;
      let attempts = 0;
      try {
        await governor.acquire(manifest);
        const credentials = credentialsFor(ctx, manifest.credentials);
        const request: AgentExecutionRequest = { manifest, input, ctx, credentials };
        const maxAttempts = manifest.policy?.retry?.maxAttempts ?? 1;
        while (attempts < maxAttempts) {
          attempts += 1;
          try {
            output = manifest.kind === 'http'
              ? await executeHttp(manifest, ctx, input, fetchImpl)
              : manifest.kind === 'python'
                ? await (dependencies.executePython ?? ((item) => executeJsonProcess(manifest.config as PythonAgentConfig, item)))(request)
                : await (dependencies.executeMcp ?? ((item) => executeMcp(manifest.config as McpAgentConfig, item)))(request);
            break;
          } catch (attemptError) {
            if (attempts >= maxAttempts) throw attemptError;
            await sleep(retryDelayMs(manifest, attempts));
          }
        }
        return { summary: `Agent ${manifest.id} completed`, raw: output };
      } catch (caught) {
        error = caught;
        throw caught;
      } finally {
        const durationMs = Math.max(0, clock.now() - startedAt);
        const event: AgentUsageEvent = {
          agentId: manifest.id,
          kind: manifest.kind,
          occurredAt: new Date(clock.now()).toISOString(),
          durationMs,
          status: error ? 'error' : 'success',
          inputBytes: jsonByteLength(input),
          outputBytes: output === undefined ? 0 : jsonByteLength(output),
          ...(attempts > 1 ? { attempts } : {}),
          ...(output === undefined ? {} : extractUsage(output)),
          ...(ctx.actor?.userId ? { userId: ctx.actor.userId } : {}),
          ...(ctx.actor?.departmentId ? { departmentId: ctx.actor.departmentId } : {}),
        };
        await dependencies.usageRecorder?.record(event);
      }
    },
  }));
}
