#!/usr/bin/env node
/**
 * Standalone MCP server exposing the capability registry.
 *
 * This is the "out-of-process" half of the same tool implementations the
 * in-process path uses — the registry below has no notion of which one it is
 * serving. The request-handler shape mirrors the base's own
 * `packages/session-mcp-server/src/index.ts` so it drops into the same places:
 * same stdio transport, same `tools/list` + `tools/call` contracts, same
 * `__CALLBACK__` stderr convention for host-directed messages.
 *
 * Usage:
 *   node adapter/mcp-server.ts --session-id <id> --workspace-root <path>
 *
 * Credentials are read from the environment by placeholder name. Nothing is
 * baked in: unconfigured placeholders resolve to null and the capability then
 * fails loudly naming what is missing.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';

import { createWorkbenchRegistry } from '../src/index.ts';
import { parseAgentWorkbenchConfig } from '../src/agent-manifest.ts';
import { ExecutionGovernor } from '../src/execution-governor.ts';
import { EncryptedFileSecretVault } from '../src/secret-vault.ts';
import { JsonlUsageLedger } from '../src/usage-ledger.ts';
import { JsonlCaseMemory } from '../src/case-memory.ts';
import type { CredentialReader, ToolContext } from '../src/ports.ts';
import { listCapabilityTools, callCapabilityTool } from './mcp-tools.ts';
import { staticCredentials, type SessionContextLike } from './session-context-bridge.ts';

export interface ServerConfig {
  readonly sessionId: string;
  readonly workspaceRootPath: string;
  /** Optional admin-controlled JSON manifest for Python / HTTP / MCP agents. */
  readonly agentsConfigPath?: string;
  /** Optional AES-GCM local secret store created by the Control Center. */
  readonly secretStorePath?: string;
  readonly masterKeyEnv?: string;
}

export function parseArgs(argv: readonly string[]): ServerConfig {
  const read = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const sessionId = read('--session-id');
  const workspaceRootPath = read('--workspace-root');
  if (!sessionId || !workspaceRootPath) {
    throw new Error('Both --session-id and --workspace-root are required');
  }
  const agentsConfigPath = read('--agents-config');
  const secretStorePath = read('--secret-store');
  const masterKeyEnv = read('--master-key-env');
  return {
    sessionId,
    workspaceRootPath,
    ...(agentsConfigPath ? { agentsConfigPath } : {}),
    ...(secretStorePath ? { secretStorePath } : {}),
    ...(masterKeyEnv ? { masterKeyEnv } : {}),
  };
}

/**
 * Builds the base-shaped context from the filesystem, the same way the base's
 * own session MCP server does for its non-Electron host.
 */
export function createHostContext(config: ServerConfig): SessionContextLike {
  const { sessionId, workspaceRootPath } = config;
  return {
    sessionId,
    workspacePath: workspaceRootPath,
    fs: {
      exists: (path: string) => existsSync(path),
      readFile: (path: string) => readFileSync(path, 'utf-8'),
      writeFile: (path: string, content: string) => writeFileSync(path, content, 'utf-8'),
      readdir: (path: string) => readdirSync(path),
    },
    loadSourceConfig: (sourceSlug: string) => {
      const configPath = join(workspaceRootPath, 'sources', sourceSlug, 'config.json');
      if (!existsSync(configPath)) return null;
      try {
        return JSON.parse(readFileSync(configPath, 'utf-8')) as unknown;
      } catch {
        return null;
      }
    },
  };
}

/** Env-backed credentials: only placeholder names, never literal secrets. */
export function credentialsFromEnv(env: NodeJS.ProcessEnv = process.env): CredentialReader {
  return staticCredentials(env as unknown as Record<string, string | null>);
}

async function credentialsForRequest(config: ServerConfig): Promise<CredentialReader> {
  const environment = credentialsFromEnv();
  if (!config.secretStorePath) return environment;
  const keyEnv = config.masterKeyEnv ?? 'AGENT_WORKBENCH_MASTER_KEY';
  const masterKey = process.env[keyEnv];
  if (!masterKey) throw new Error(`Missing required master-key environment variable: ${keyEnv}`);
  const vault = await EncryptedFileSecretVault.open(config.secretStorePath, masterKey);
  return { read: (name) => vault.read(name) ?? environment.read(name) };
}

/** Exposed for tests: the full tool list the server advertises. */
export function advertisedTools(): Tool[] {
  return listCapabilityTools(createWorkbenchRegistry()).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema as Tool['inputSchema'],
  }));
}

export async function startServer(config: ServerConfig): Promise<void> {
  const usage = new JsonlUsageLedger(join(config.workspaceRootPath, '.agent-workbench', 'usage.jsonl'));
  const caseMemory = new JsonlCaseMemory(join(config.workspaceRootPath, '.agent-workbench', 'case-memory.jsonl'));
  const governor = new ExecutionGovernor({ usageReader: usage });
  /** Reloads the Control Center manifest at MCP request boundaries. */
  const registryForRequest = () => {
    const configured = config.agentsConfigPath
      ? parseAgentWorkbenchConfig(JSON.parse(readFileSync(config.agentsConfigPath, 'utf8')) as unknown)
      : undefined;
    return createWorkbenchRegistry({
      ...(configured?.agents ? { agents: configured.agents } : {}),
      ...(configured?.includeBuiltinAgents === undefined ? {} : { includeBuiltinAgents: configured.includeBuiltinAgents }),
      runtime: { usageRecorder: usage, usageReader: usage, governor, caseMemory },
    });
  };
  const host = createHostContext(config);
  const ctx: ToolContext = {
    sessionId: host.sessionId,
    workspacePath: host.workspacePath,
    credentials: credentialsFromEnv(),
  };

  const server = new Server(
    { name: 'agent-workbench', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listCapabilityTools(registryForRequest()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as Tool['inputSchema'],
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const registry = registryForRequest();
    const requestContext: ToolContext = { ...ctx, credentials: await credentialsForRequest(config) };
    const { name, arguments: toolArgs } = request.params;
    const result = await callCapabilityTool(
      registry,
      { idForToolName: (toolName) => registry.idForToolName(toolName) },
      requestContext,
      name,
      (toolArgs ?? {}) as Record<string, unknown>,
    );
    // The SDK derives CallToolResult from a Zod schema, so its inferred shape
    // carries index signatures and optional task fields that a hand-written
    // type cannot satisfy structurally. The wire shape is identical; this is
    // the single point where we cross from our own type into the protocol's.
    return result as unknown as CallToolResult;
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`agent-workbench MCP server started for session ${config.sessionId}`);
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return resolvePath(entry) === resolvePath(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  startServer(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
