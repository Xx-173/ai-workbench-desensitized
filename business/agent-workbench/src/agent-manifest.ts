/**
 * Declarative agent manifests.
 *
 * A manifest is the admin-controlled contract for one external capability.
 * It contains reference names only: secrets remain in Craft's credential
 * manager (or an injected CredentialReader) and are never stored in config.
 */

import type { InputSchema, JsonObject } from './ports.ts';

export type AgentKind = 'http' | 'python' | 'mcp';

export interface CredentialBinding {
  /** Name exposed to the invoked agent, e.g. `OPENAI_API_KEY`. */
  readonly name: string;
  /** Credential reference resolved by the host, e.g. `COPYWRITER_API_KEY`. */
  readonly source: string;
}

export interface HttpAgentConfig {
  readonly baseUrlEnv: string;
  readonly path: string;
  readonly tokenEnv?: string;
  readonly tokenHeader?: string;
  readonly tokenPrefix?: string;
  /** Generic JSON, Dify workflow and Coze workflow envelopes are built in. */
  readonly payloadMode?: 'input' | 'dify-workflow' | 'coze-workflow';
  /** Non-secret provider configuration, such as a placeholder workflow id. */
  readonly staticBody?: JsonObject;
}

export interface PythonAgentConfig {
  /** Executed directly, never by a shell. It is configured by an administrator. */
  readonly command: string;
  readonly args?: readonly string[];
}

export interface McpAgentConfig {
  /** Command for an administrator-approved stdio MCP server. */
  readonly command: string;
  readonly args?: readonly string[];
  readonly toolName: string;
}

export interface RetryPolicy {
  /** Includes the first attempt; a retry is only for a failed invocation. */
  readonly maxAttempts: number;
  readonly backoffMs?: number;
}

export interface RateLimitPolicy {
  readonly maxRequests: number;
  readonly windowMs: number;
}

export interface QuotaPolicy {
  readonly maxCallsPerDay?: number;
  readonly maxTokensPerDay?: number;
}

/** Prices are optional administrator-configured estimates, per one million tokens. */
export interface CostPolicy {
  readonly inputPerMillion?: number;
  readonly outputPerMillion?: number;
  readonly currency?: string;
}

export interface AgentExecutionPolicy {
  readonly retry?: RetryPolicy;
  readonly rateLimit?: RateLimitPolicy;
  readonly quota?: QuotaPolicy;
  readonly cost?: CostPolicy;
}

export interface AgentManifest {
  readonly id: string;
  readonly toolName: string;
  readonly description: string;
  readonly kind: AgentKind;
  readonly inputSchema: InputSchema;
  readonly credentials?: readonly CredentialBinding[];
  readonly timeoutMs?: number;
  readonly policy?: AgentExecutionPolicy;
  readonly config: HttpAgentConfig | PythonAgentConfig | McpAgentConfig;
}

export interface AgentWorkbenchConfig {
  /** Keep the first-party sample agents available alongside configured agents. */
  readonly includeBuiltinAgents?: boolean;
  readonly agents: readonly AgentManifest[];
}

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{1,127}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`Invalid agent config: ${field} must be a non-empty string`);
  return value;
}

function expectIdentifier(value: unknown, field: string, pattern = IDENTIFIER): string {
  const result = expectString(value, field);
  if (!pattern.test(result)) throw new Error(`Invalid agent config: ${field} has an unsafe format`);
  return result;
}

function parseSchema(value: unknown, id: string): InputSchema {
  if (!isObject(value) || value.type !== 'object' || !isObject(value.properties)) {
    throw new Error(`Invalid agent config: ${id}.inputSchema must be an object schema`);
  }
  const properties: Record<string, { type: 'string' | 'number' | 'boolean' | 'array'; description: string; items?: { type: 'string' | 'number' } }> = {};
  for (const [name, field] of Object.entries(value.properties)) {
    if (!isObject(field) || !['string', 'number', 'boolean', 'array'].includes(String(field.type))) {
      throw new Error(`Invalid agent config: ${id}.inputSchema.properties.${name}`);
    }
    const type = field.type as 'string' | 'number' | 'boolean' | 'array';
    const description = typeof field.description === 'string' ? field.description : name;
    const items: { type: 'string' | 'number' } | undefined = isObject(field.items) && (field.items.type === 'string' || field.items.type === 'number')
      ? { type: field.items.type as 'string' | 'number' }
      : undefined;
    properties[name] = { type, description, ...(items ? { items } : {}) };
  }
  const required = value.required === undefined
    ? undefined
    : Array.isArray(value.required) && value.required.every((name) => typeof name === 'string')
      ? value.required as string[]
      : (() => { throw new Error(`Invalid agent config: ${id}.inputSchema.required`); })();
  return { type: 'object', properties, ...(required ? { required } : {}) };
}

function parseCredentials(value: unknown, id: string): readonly CredentialBinding[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`Invalid agent config: ${id}.credentials must be an array`);
  return value.map((binding, index) => {
    if (!isObject(binding)) throw new Error(`Invalid agent config: ${id}.credentials[${index}]`);
    return {
      name: expectIdentifier(binding.name, `${id}.credentials[${index}].name`, ENV_NAME),
      source: expectIdentifier(binding.source, `${id}.credentials[${index}].source`, ENV_NAME),
    };
  });
}

function parseArgs(value: unknown, field: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((arg) => typeof arg === 'string')) {
    throw new Error(`Invalid agent config: ${field} must be an array of strings`);
  }
  return value as string[];
}

function parsePositiveInteger(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Invalid agent config: ${field} must be an integer in ${min}..${max}`);
  }
  return value;
}

function parseNonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid agent config: ${field} must be a non-negative number`);
  }
  return value;
}

function parsePolicy(value: unknown, id: string): AgentExecutionPolicy | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) throw new Error(`Invalid agent config: ${id}.policy must be an object`);
  const retry = value.retry;
  const rateLimit = value.rateLimit;
  const quota = value.quota;
  const cost = value.cost;
  if (retry !== undefined && !isObject(retry)) throw new Error(`Invalid agent config: ${id}.policy.retry`);
  if (rateLimit !== undefined && !isObject(rateLimit)) throw new Error(`Invalid agent config: ${id}.policy.rateLimit`);
  if (quota !== undefined && !isObject(quota)) throw new Error(`Invalid agent config: ${id}.policy.quota`);
  if (cost !== undefined && !isObject(cost)) throw new Error(`Invalid agent config: ${id}.policy.cost`);
  const parsedRetry = retry === undefined ? undefined : {
    maxAttempts: parsePositiveInteger(retry.maxAttempts, `${id}.policy.retry.maxAttempts`, 1, 5),
    ...(retry.backoffMs === undefined ? {} : { backoffMs: parsePositiveInteger(retry.backoffMs, `${id}.policy.retry.backoffMs`, 0, 60_000) }),
  };
  const parsedRateLimit = rateLimit === undefined ? undefined : {
    maxRequests: parsePositiveInteger(rateLimit.maxRequests, `${id}.policy.rateLimit.maxRequests`, 1, 10_000),
    windowMs: parsePositiveInteger(rateLimit.windowMs, `${id}.policy.rateLimit.windowMs`, 1_000, 86_400_000),
  };
  const parsedQuota = quota === undefined ? undefined : {
    ...(quota.maxCallsPerDay === undefined ? {} : { maxCallsPerDay: parsePositiveInteger(quota.maxCallsPerDay, `${id}.policy.quota.maxCallsPerDay`, 1, 10_000_000) }),
    ...(quota.maxTokensPerDay === undefined ? {} : { maxTokensPerDay: parsePositiveInteger(quota.maxTokensPerDay, `${id}.policy.quota.maxTokensPerDay`, 1, 10_000_000_000) }),
  };
  const parsedCost = cost === undefined ? undefined : {
    ...(cost.inputPerMillion === undefined ? {} : { inputPerMillion: parseNonNegativeNumber(cost.inputPerMillion, `${id}.policy.cost.inputPerMillion`) }),
    ...(cost.outputPerMillion === undefined ? {} : { outputPerMillion: parseNonNegativeNumber(cost.outputPerMillion, `${id}.policy.cost.outputPerMillion`) }),
    ...(cost.currency === undefined ? {} : { currency: expectIdentifier(cost.currency, `${id}.policy.cost.currency`, /^[A-Z]{3}$/) }),
  };
  return {
    ...(parsedRetry ? { retry: parsedRetry } : {}),
    ...(parsedRateLimit ? { rateLimit: parsedRateLimit } : {}),
    ...(parsedQuota && Object.keys(parsedQuota).length ? { quota: parsedQuota } : {}),
    ...(parsedCost && Object.keys(parsedCost).length ? { cost: parsedCost } : {}),
  };
}

function parseManifest(value: unknown, index: number): AgentManifest {
  if (!isObject(value)) throw new Error(`Invalid agent config: agents[${index}] must be an object`);
  const id = expectIdentifier(value.id, `agents[${index}].id`);
  const toolName = expectIdentifier(value.toolName, `${id}.toolName`, TOOL_NAME);
  const kind = value.kind;
  if (kind !== 'http' && kind !== 'python' && kind !== 'mcp') throw new Error(`Invalid agent config: ${id}.kind`);
  if (!isObject(value.config)) throw new Error(`Invalid agent config: ${id}.config`);
  const policy = parsePolicy(value.policy, id);
  const common = {
    id,
    toolName,
    description: expectString(value.description, `${id}.description`),
    kind,
    inputSchema: parseSchema(value.inputSchema, id),
    ...(parseCredentials(value.credentials, id) ? { credentials: parseCredentials(value.credentials, id) } : {}),
    ...(policy && Object.keys(policy).length ? { policy } : {}),
    ...(value.timeoutMs === undefined ? {} : {
      timeoutMs: typeof value.timeoutMs === 'number' && Number.isInteger(value.timeoutMs) && value.timeoutMs >= 1_000 && value.timeoutMs <= 300_000
        ? value.timeoutMs
        : (() => { throw new Error(`Invalid agent config: ${id}.timeoutMs must be 1000..300000`); })(),
    }),
  } as const;

  if (kind === 'http') {
    const payloadMode = value.config.payloadMode;
    if (payloadMode !== undefined && payloadMode !== 'input' && payloadMode !== 'dify-workflow' && payloadMode !== 'coze-workflow') {
      throw new Error(`Invalid agent config: ${id}.config.payloadMode`);
    }
    if (value.config.staticBody !== undefined && !isObject(value.config.staticBody)) {
      throw new Error(`Invalid agent config: ${id}.config.staticBody must be an object`);
    }
    return {
      ...common,
      kind,
      config: {
        baseUrlEnv: expectIdentifier(value.config.baseUrlEnv, `${id}.config.baseUrlEnv`, ENV_NAME),
        path: expectString(value.config.path, `${id}.config.path`),
        ...(value.config.tokenEnv === undefined ? {} : { tokenEnv: expectIdentifier(value.config.tokenEnv, `${id}.config.tokenEnv`, ENV_NAME) }),
        ...(value.config.tokenHeader === undefined ? {} : { tokenHeader: expectString(value.config.tokenHeader, `${id}.config.tokenHeader`) }),
        ...(value.config.tokenPrefix === undefined ? {} : { tokenPrefix: expectString(value.config.tokenPrefix, `${id}.config.tokenPrefix`) }),
        ...(payloadMode === undefined ? {} : { payloadMode }),
        ...(value.config.staticBody === undefined ? {} : { staticBody: value.config.staticBody as JsonObject }),
      },
    };
  }

  const command = expectString(value.config.command, `${id}.config.command`);
  const args = parseArgs(value.config.args, `${id}.config.args`);
  if (kind === 'python') return { ...common, kind, config: { command, ...(args ? { args } : {}) } };
  return {
    ...common,
    kind,
    config: {
      command,
      ...(args ? { args } : {}),
      toolName: expectIdentifier(value.config.toolName, `${id}.config.toolName`, TOOL_NAME),
    },
  };
}

/** Parses checked-in JSON before it can create an executable integration. */
export function parseAgentWorkbenchConfig(value: unknown): AgentWorkbenchConfig {
  if (!isObject(value) || !Array.isArray(value.agents)) throw new Error('Invalid agent config: agents must be an array');
  if (value.includeBuiltinAgents !== undefined && typeof value.includeBuiltinAgents !== 'boolean') {
    throw new Error('Invalid agent config: includeBuiltinAgents must be boolean');
  }
  const agents = value.agents.map(parseManifest);
  const ids = new Set<string>();
  const tools = new Set<string>();
  for (const agent of agents) {
    if (ids.has(agent.id)) throw new Error(`Invalid agent config: duplicate id ${agent.id}`);
    if (tools.has(agent.toolName)) throw new Error(`Invalid agent config: duplicate toolName ${agent.toolName}`);
    ids.add(agent.id);
    tools.add(agent.toolName);
  }
  return { ...(value.includeBuiltinAgents === undefined ? {} : { includeBuiltinAgents: value.includeBuiltinAgents }), agents };
}

/**
 * The exact reference names a Craft host must resolve before starting a task.
 * This keeps secret lookup in the base credential manager rather than in a
 * Manifest, adapter, or individual Agent implementation.
 */
export function collectCredentialReferenceNames(manifests: readonly AgentManifest[]): readonly string[] {
  const names = new Set<string>();
  for (const manifest of manifests) {
    for (const binding of manifest.credentials ?? []) names.add(binding.source);
    if (manifest.kind === 'http') {
      // `AgentManifest` intentionally stores a union for config; kind is the
      // validated discriminator at this boundary.
      const config = manifest.config as HttpAgentConfig;
      names.add(config.baseUrlEnv);
      if (config.tokenEnv) names.add(config.tokenEnv);
    }
  }
  return [...names].sort();
}
