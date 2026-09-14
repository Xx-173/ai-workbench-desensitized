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
export * from './account-revocation.ts';
export * from './business-events.ts';
export * from './remote.ts';

import { CapabilityRegistry } from './capability-registry.ts';
import { capabilities } from './capabilities.ts';

/** Builds the registry with every declared capability attached. */
export function createWorkbenchRegistry(): CapabilityRegistry {
  return new CapabilityRegistry().registerAll(capabilities);
}
