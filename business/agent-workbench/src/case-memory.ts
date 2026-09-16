/**
 * Privacy-preserving operational case memory.
 *
 * This is deliberately not a prompt or response cache. It retains a
 * fingerprint and execution facts so operators can recognize a recurring
 * successful integration or failure mode without collecting business text,
 * upstream URLs, credentials, or full Agent output.
 */

import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type CaseOutcome = 'success' | 'failure';

export interface AgentCaseMemoryEntry {
  readonly id: string;
  readonly agentId: string;
  readonly occurredAt: string;
  readonly outcome: CaseOutcome;
  /** SHA-256 of canonical input; the input itself is never persisted. */
  readonly inputFingerprint: string;
  readonly inputBytes: number;
  readonly outputBytes: number;
  readonly durationMs: number;
  readonly attempts: number;
  /** A runbook action selected from a small safe vocabulary. */
  readonly strategy: string;
  /** Stable error class only; never an upstream response/error message. */
  readonly failureCategory?: string;
}

export interface CaseMemoryRecorder {
  record(entry: AgentCaseMemoryEntry): Promise<void> | void;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(',')}}`;
}

export function fingerprintCaseInput(input: unknown): string {
  return createHash('sha256').update(canonicalize(input)).digest('hex');
}

/** Build a content-free case record. Callers must never add raw input/output fields. */
export function createCaseMemoryEntry(input: Omit<AgentCaseMemoryEntry, 'id' | 'inputFingerprint'> & { readonly input: unknown }): AgentCaseMemoryEntry {
  const { input: rawInput, ...entry } = input;
  return { id: randomUUID(), inputFingerprint: fingerprintCaseInput(rawInput), ...entry };
}

export class InMemoryCaseMemory implements CaseMemoryRecorder {
  private readonly entries: AgentCaseMemoryEntry[] = [];

  record(entry: AgentCaseMemoryEntry): void {
    this.entries.push(entry);
  }

  list(): readonly AgentCaseMemoryEntry[] {
    return [...this.entries];
  }

  /** Finds the newest known successful execution of the same redacted input. */
  recentSuccess(agentId: string, input: unknown): AgentCaseMemoryEntry | undefined {
    const fingerprint = fingerprintCaseInput(input);
    return [...this.entries].reverse().find((entry) => entry.agentId === agentId && entry.outcome === 'success' && entry.inputFingerprint === fingerprint);
  }
}

/** Durable JSONL artifact for an operations team; safe to aggregate or archive. */
export class JsonlCaseMemory implements CaseMemoryRecorder {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async record(entry: AgentCaseMemoryEntry): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  async list(): Promise<readonly AgentCaseMemoryEntry[]> {
    let raw = '';
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as AgentCaseMemoryEntry);
  }
}
