import { readFile, stat, writeFile } from 'node:fs/promises';

import {
  assertSafeRelativePath,
  createTaskWorkspace,
  listArtifacts,
  resolveInTask,
  type TaskArea,
  type TaskWorkspace,
} from './task-workspace.ts';

export type TaskArtifactArea = Extract<TaskArea, 'inputs' | 'outputs' | 'tmp'>;

export interface TaskArtifact {
  readonly taskId: string;
  readonly area: TaskArtifactArea;
  readonly filename: string;
  readonly relativePath: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
}

export interface StoredTaskArtifact extends TaskArtifact {
  readonly absolutePath: string;
}

export interface PutTaskArtifactInput {
  readonly workspacePath: string;
  readonly taskId: string;
  readonly area: TaskArtifactArea;
  readonly filename: string;
  readonly mimeType?: string;
  readonly bytes: Uint8Array;
}

export interface TaskArtifactStore {
  put(input: PutTaskArtifactInput): Promise<TaskArtifact>;
  list(workspacePath: string, taskId: string): Promise<TaskArtifact[]>;
  read(workspacePath: string, taskId: string, area: TaskArtifactArea, filename: string): Promise<{ artifact: TaskArtifact; bytes: Buffer } | null>;
}

function safeFilename(taskId: string, value: string): string {
  if (value.includes('/') || value.includes('\\')) throw new Error(`Artifact filename must not contain a path: ${value}`);
  const candidate = value.replace(/[\u0000\r\n]/g, '').trim();
  const name = candidate || `artifact-${Date.now()}`;
  return assertSafeRelativePath(taskId, name);
}

function toArtifact(ws: TaskWorkspace, area: TaskArtifactArea, filename: string, mimeType: string, sizeBytes: number, createdAt: string): StoredTaskArtifact {
  return {
    taskId: ws.taskId,
    area,
    filename,
    relativePath: `${area}/${filename}`,
    mimeType,
    sizeBytes,
    createdAt,
    absolutePath: resolveInTask(ws, area, filename),
  };
}

/**
 * Single-node task artifact store.
 *
 * The interface is deliberately small so it can later be replaced with an
 * S3/OSS/MinIO implementation without changing the browser API or Agent
 * Runtime. The current implementation keeps the same Workspace semantics as
 * Craft and is suitable for local previews and a single-server deployment.
 */
export class LocalTaskArtifactStore implements TaskArtifactStore {
  async put(input: PutTaskArtifactInput): Promise<TaskArtifact> {
    const ws = await createTaskWorkspace(input.workspacePath, input.taskId);
    const filename = safeFilename(ws.taskId, input.filename);
    const target = resolveInTask(ws, input.area, filename);
    await writeFile(target, input.bytes);
    const info = await stat(target);
    return toArtifact(ws, input.area, filename, input.mimeType || 'application/octet-stream', info.size, info.birthtime.toISOString());
  }

  async list(workspacePath: string, taskId: string): Promise<TaskArtifact[]> {
    const ws = await createTaskWorkspace(workspacePath, taskId);
    const paths = await listArtifacts(ws);
    const result: TaskArtifact[] = [];
    for (const relativePath of paths) {
      const [area, ...parts] = relativePath.split('/');
      if (area !== 'inputs' && area !== 'outputs' && area !== 'tmp') continue;
      const filename = parts.join('/');
      const filePath = resolveInTask(ws, area, filename);
      const info = await stat(filePath);
      result.push(toArtifact(ws, area, filename, 'application/octet-stream', info.size, info.birthtime.toISOString()));
    }
    return result;
  }

  async read(workspacePath: string, taskId: string, area: TaskArtifactArea, filename: string): Promise<{ artifact: TaskArtifact; bytes: Buffer } | null> {
    const ws = await createTaskWorkspace(workspacePath, taskId);
    const safe = assertSafeRelativePath(taskId, filename);
    const filePath = resolveInTask(ws, area, safe);
    try {
      const [bytes, info] = await Promise.all([readFile(filePath), stat(filePath)]);
      return {
        artifact: toArtifact(ws, area, safe, 'application/octet-stream', info.size, info.birthtime.toISOString()),
        bytes,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
}
