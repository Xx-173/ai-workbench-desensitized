/**
 * Shared runtime safeguards for configured agents.
 *
 * Rate limits are process-local sliding windows; quotas can additionally read
 * durable, content-free usage events so they survive a server restart.
 */

import type { AgentManifest } from './agent-manifest.ts';
import type { Clock } from './ports.ts';
import { systemClock } from './ports.ts';
import type { UsageReader } from './usage-ledger.ts';

export class RateLimitExceededError extends Error {
  constructor(agentId: string) {
    super(`Rate limit exceeded for agent: ${agentId}`);
    this.name = 'RateLimitExceededError';
  }
}

export class QuotaExceededError extends Error {
  constructor(agentId: string, quota: 'calls' | 'tokens') {
    super(`Daily ${quota} quota exceeded for agent: ${agentId}`);
    this.name = 'QuotaExceededError';
  }
}

function utcDayStart(now: number): Date {
  const date = new Date(now);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export class ExecutionGovernor {
  private readonly starts = new Map<string, number[]>();
  private readonly clock: Clock;
  private readonly usageReader?: UsageReader;

  constructor(options: { clock?: Clock; usageReader?: UsageReader } = {}) {
    this.clock = options.clock ?? systemClock;
    this.usageReader = options.usageReader;
  }

  async acquire(manifest: AgentManifest): Promise<void> {
    await this.enforceQuota(manifest);
    this.enforceRateLimit(manifest);
  }

  private enforceRateLimit(manifest: AgentManifest): void {
    const policy = manifest.policy?.rateLimit;
    if (!policy) return;
    const now = this.clock.now();
    const active = (this.starts.get(manifest.id) ?? []).filter((startedAt) => now - startedAt < policy.windowMs);
    if (active.length >= policy.maxRequests) throw new RateLimitExceededError(manifest.id);
    active.push(now);
    this.starts.set(manifest.id, active);
  }

  private async enforceQuota(manifest: AgentManifest): Promise<void> {
    const policy = manifest.policy?.quota;
    if (!policy || !this.usageReader) return;
    const events = await this.usageReader.listSince(utcDayStart(this.clock.now()));
    const ownEvents = events.filter((event) => event.agentId === manifest.id);
    if (policy.maxCallsPerDay !== undefined && ownEvents.length >= policy.maxCallsPerDay) {
      throw new QuotaExceededError(manifest.id, 'calls');
    }
    if (policy.maxTokensPerDay !== undefined) {
      const tokens = ownEvents.reduce((total, event) => total + (event.inputTokens ?? 0) + (event.outputTokens ?? 0), 0);
      if (tokens >= policy.maxTokensPerDay) throw new QuotaExceededError(manifest.id, 'tokens');
    }
  }
}

export function retryDelayMs(manifest: AgentManifest, failedAttempt: number): number {
  const backoff = manifest.policy?.retry?.backoffMs ?? 0;
  return Math.min(60_000, backoff * (2 ** Math.max(0, failedAttempt - 1)));
}
