import { randomUUID } from 'node:crypto';
import { Redis as RedisClient } from 'ioredis';

export interface WorkbenchTaskEnvelope<T = unknown> {
  readonly id: string;
  readonly payload: T;
  readonly createdAt: string;
  readonly attempts: number;
}

export type WorkbenchTaskStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface WorkbenchTaskStatusRecord {
  readonly taskId: string;
  readonly status: WorkbenchTaskStatus;
  readonly updatedAt: string;
  readonly result?: unknown;
  readonly error?: string;
}

export interface TaskQueue<T = unknown> {
  enqueue(payload: T): Promise<WorkbenchTaskEnvelope<T>>;
  close(): Promise<void>;
}

export interface TaskWorkerOptions<T = unknown> {
  readonly consumer: string;
  readonly handler: (task: WorkbenchTaskEnvelope<T>) => Promise<unknown>;
  readonly signal?: AbortSignal;
}

/**
 * Redis Streams queue used by the server/worker split in production.
 * Consumer groups provide at-least-once delivery; handlers must therefore be
 * idempotent (the task id is stable across retries).
 */
export class RedisTaskQueue<T = unknown> implements TaskQueue<T> {
  readonly stream: string;
  readonly group: string;
  private readonly client: RedisClient;
  private readonly reader: RedisClient;
  private groupReady: Promise<void> | null = null;

  constructor(url: string, options: { stream?: string; group?: string } = {}) {
    this.stream = options.stream ?? 'craft-workbench:tasks';
    this.group = options.group ?? 'craft-workbench-workers';
    this.client = new RedisClient(url, { lazyConnect: false, maxRetriesPerRequest: null });
    this.reader = this.client.duplicate({ lazyConnect: false, maxRetriesPerRequest: null });
  }

  async enqueue(payload: T): Promise<WorkbenchTaskEnvelope<T>> {
    await this.ensureGroup();
    const task: WorkbenchTaskEnvelope<T> = { id: randomUUID(), payload, createdAt: new Date().toISOString(), attempts: 0 };
    await this.client.xadd(this.stream, 'MAXLEN', '~', '10000', '*', 'payload', JSON.stringify(task));
    await this.setStatus({ taskId: task.id, status: 'queued', updatedAt: new Date().toISOString() });
    return task;
  }

  async setStatus(status: WorkbenchTaskStatusRecord): Promise<void> {
    await this.client.set(this.statusKey(status.taskId), JSON.stringify(status), 'EX', '86400');
  }

  async getStatus(taskId: string): Promise<WorkbenchTaskStatusRecord | null> {
    const value = await this.client.get(this.statusKey(taskId));
    return value ? JSON.parse(value) as WorkbenchTaskStatusRecord : null;
  }

  async ping(): Promise<string> {
    return this.client.ping();
  }

  async runWorker(options: TaskWorkerOptions<T>): Promise<void> {
    await this.ensureGroup();
    const onAbort = () => { void this.reader.disconnect(); };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      while (!options.signal?.aborted) {
        const reply = await this.reader.xreadgroup('GROUP', this.group, options.consumer, 'COUNT', '1', 'BLOCK', '1000', 'STREAMS', this.stream, '>') as Array<[string, Array<[string, string[]]>]> | null;
        if (!reply?.length) continue;
        for (const [, messages] of reply) {
          for (const [messageId, fields] of messages) {
            const payloadIndex = fields.indexOf('payload');
            if (payloadIndex < 0 || !fields[payloadIndex + 1]) {
              await this.reader.xack(this.stream, this.group, messageId);
              continue;
            }
            const task = JSON.parse(fields[payloadIndex + 1]!) as WorkbenchTaskEnvelope<T>;
            try {
              await this.setStatus({ taskId: task.id, status: 'running', updatedAt: new Date().toISOString() });
              const result = await options.handler({ ...task, attempts: task.attempts + 1 });
              await this.setStatus({ taskId: task.id, status: 'succeeded', updatedAt: new Date().toISOString(), ...(result === undefined ? {} : { result }) });
              await this.reader.xack(this.stream, this.group, messageId);
            } catch (error) {
              await this.setStatus({ taskId: task.id, status: 'failed', updatedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) });
              // Leave the message pending so an operator can inspect/reclaim it.
              console.error(`[workbench-worker] task ${task.id} failed:`, error);
            }
          }
        }
      }
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.reader.quit(), this.client.quit()]);
  }

  private async ensureGroup(): Promise<void> {
    if (!this.groupReady) {
      this.groupReady = this.client.xgroup('CREATE', this.stream, this.group, '$', 'MKSTREAM')
        .catch((error: unknown) => {
          if (error instanceof Error && /BUSYGROUP/i.test(error.message)) return;
          throw error;
        }).then(() => undefined);
    }
    await this.groupReady;
  }

  private statusKey(taskId: string): string {
    return `${this.stream}:status:${taskId}`;
  }
}

/** In-memory queue for unit tests and the single-process local preview. */
export class InMemoryTaskQueue<T = unknown> implements TaskQueue<T> {
  readonly tasks: WorkbenchTaskEnvelope<T>[] = [];
  readonly statuses = new Map<string, WorkbenchTaskStatusRecord>();

  async enqueue(payload: T): Promise<WorkbenchTaskEnvelope<T>> {
    const task = { id: randomUUID(), payload, createdAt: new Date().toISOString(), attempts: 0 };
    this.tasks.push(task);
    this.statuses.set(task.id, { taskId: task.id, status: 'queued', updatedAt: new Date().toISOString() });
    return task;
  }

  async setStatus(status: WorkbenchTaskStatusRecord): Promise<void> { this.statuses.set(status.taskId, status); }

  async getStatus(taskId: string): Promise<WorkbenchTaskStatusRecord | null> { return this.statuses.get(taskId) ?? null; }

  async close(): Promise<void> {}
}
