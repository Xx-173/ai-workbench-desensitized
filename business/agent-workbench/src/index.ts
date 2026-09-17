/**
 * Public surface of the business layer.
 *
 * Everything here is *additive*. No file under `packages/`, `apps/` was
 * modified to make this work — which is exactly the property the resume
 * claims ("...without changing the agent execution core").
 */

export * from './ports.ts';
export * from './capability-registry.ts';
export * from './capabilities.ts';
export * from './video-chapters.ts';
export * from './task-workspace.ts';
export * from './task-artifacts.ts';
export * from './account-revocation.ts';
export * from './business-events.ts';
export * from './remote.ts';
export * from './agent-manifest.ts';
export * from './agent-runtime.ts';
export * from './usage-ledger.ts';
export * from './case-memory.ts';
export * from './execution-governor.ts';
export * from './video-chapter-eval.ts';
export * from './secret-vault.ts';
export * from './control-plane.ts';
export * from './result-mapper.ts';
export * from './team-directory.ts';

import { CapabilityRegistry } from './capability-registry.ts';
import { capabilities } from './capabilities.ts';
import type { AgentManifest } from './agent-manifest.ts';
import { createAgentEntries, type AgentRuntimeDependencies } from './agent-runtime.ts';

export interface WorkbenchRegistryOptions {
  /** Manifest-defined Python, HTTP and MCP agents. */
  readonly agents?: readonly AgentManifest[];
  /** The five sample implementations remain opt-in when a custom config loads. */
  readonly includeBuiltinAgents?: boolean;
  readonly runtime?: AgentRuntimeDependencies;
}

/**
 * Builds the common invocation surface for built-in samples and configured
 * external agents. The host may pass a new manifest set without editing this
 * package or Craft's execution core.
 */
export function createWorkbenchRegistry(options: WorkbenchRegistryOptions = {}): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  if (options.includeBuiltinAgents !== false) registry.registerAll(capabilities);
  if (options.agents?.length) registry.registerAll(createAgentEntries(options.agents, options.runtime));
  return registry;
}
