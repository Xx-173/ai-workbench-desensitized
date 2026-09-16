/**
 * Privacy-preserving usage accounting.
 *
 * The ledger intentionally stores no prompts, outputs, endpoint URLs or keys.
 * It is suitable for per-agent operational accounting, not content analytics.
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface AgentUsageEvent {
  readonly agentId: string;
  readonly kind: 'http' | 'python' | 'mcp';
  readonly occurredAt: string;
  readonly durationMs: number;
  readonly status: 'success' | 'error';
  readonly inputBytes: number;
  readonly outputBytes: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly attempts?: number;
  /** Identity dimensions only; prompts, outputs, endpoints and secrets are never recorded. */
  readonly userId?: string;
  readonly departmentId?: string;
}

export interface UsageRecorder {
  record(event: AgentUsageEvent): Promise<void> | void;
}

export interface UsageReader {
  listSince(occurredAfter: Date): Promise<readonly AgentUsageEvent[]> | readonly AgentUsageEvent[];
}

export interface UsageSummary {
  readonly agentId: string;
  readonly calls: number;
  readonly successes: number;
  readonly failures: number;
  readonly durationMs: number;
  readonly inputBytes: number;
  readonly outputBytes: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export class InMemoryUsageLedger implements UsageRecorder, UsageReader {
  private readonly events: AgentUsageEvent[] = [];

  record(event: AgentUsageEvent): void {
    this.events.push(event);
  }

  list(): readonly AgentUsageEvent[] {
    return [...this.events];
  }

  listSince(occurredAfter: Date): readonly AgentUsageEvent[] {
    const threshold = occurredAfter.getTime();
    return this.events.filter((event) => Date.parse(event.occurredAt) >= threshold);
  }

  summarize(): readonly UsageSummary[] {
    const summaries = new Map<string, UsageSummary>();
    for (const event of this.events) {
      const previous = summaries.get(event.agentId) ?? {
        agentId: event.agentId, calls: 0, successes: 0, failures: 0, durationMs: 0,
        inputBytes: 0, outputBytes: 0, inputTokens: 0, outputTokens: 0,
      };
      summaries.set(event.agentId, {
        ...previous,
        calls: previous.calls + 1,
        successes: previous.successes + (event.status === 'success' ? 1 : 0),
        failures: previous.failures + (event.status === 'error' ? 1 : 0),
        durationMs: previous.durationMs + event.durationMs,
        inputBytes: previous.inputBytes + event.inputBytes,
        outputBytes: previous.outputBytes + event.outputBytes,
        inputTokens: previous.inputTokens + (event.inputTokens ?? 0),
        outputTokens: previous.outputTokens + (event.outputTokens ?? 0),
      });
    }
    return [...summaries.values()].sort((left, right) => left.agentId.localeCompare(right.agentId));
  }
}

/** JSONL keeps a durable audit trail without introducing a database dependency. */
export class JsonlUsageLedger implements UsageRecorder, UsageReader {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async record(event: AgentUsageEvent): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(event)}\n`, 'utf8');
  }

  async summarize(): Promise<readonly UsageSummary[]> {
    const ledger = new InMemoryUsageLedger();
    for (const event of await this.readEvents()) ledger.record(event);
    return ledger.summarize();
  }

  async listSince(occurredAfter: Date): Promise<readonly AgentUsageEvent[]> {
    const threshold = occurredAfter.getTime();
    return (await this.readEvents()).filter((event) => Date.parse(event.occurredAt) >= threshold);
  }

  private async readEvents(): Promise<readonly AgentUsageEvent[]> {
    let raw = '';
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const events: AgentUsageEvent[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as AgentUsageEvent;
      events.push(event);
    }
    return events;
  }
}
