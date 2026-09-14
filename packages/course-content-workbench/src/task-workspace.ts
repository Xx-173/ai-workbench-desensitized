/**
 * Per-task workspace layout (resume bullet 4 / R08).
 *
 * The base already isolates by Session / Workspace. What it does NOT know is
 * what a *business task* is. This module projects the base's isolation onto
 * business objects: every voice-clone job and every video-parse job gets its
 * own `inputs/ outputs/ tmp/` triple, and nothing can escape its own subtree.
 *
 * Boundary note (repeat this in interviews): this is directory-level
 * containment, NOT multi-tenant row-level security. Tenant ownership still
 * belongs to the persistence layer.
 */

import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join, normalize, resolve, sep } from 'node:path';

export const TASK_LAYOUT = ['inputs', 'outputs', 'tmp'] as const;

export type TaskArea = (typeof TASK_LAYOUT)[number];

export interface TaskWorkspace {
  readonly root: string;
  readonly taskId: string;
  readonly inputs: string;
  readonly outputs: string;
  readonly tmp: string;
}

export class PathEscapeError extends Error {
  constructor(taskId: string, relativePath: string) {
    super(`Path escapes task workspace "${taskId}": ${relativePath}`);
    this.name = 'PathEscapeError';
  }
}

const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Rejects anything that could traverse upward. Leading separators are
 * normalized away rather than treated as absolute — they are a common
 * upstream artifact, not an attack signal.
 */
export function assertSafeRelativePath(taskId: string, relativePath: string): string {
  const normalized = normalize(relativePath).replace(/^[/\\]+/, '');
  const parts = normalized.split(/[/\\]+/).filter((p) => p.length > 0);
  if (parts.length === 0) throw new PathEscapeError(taskId, relativePath);
  if (parts.some((p) => p === '.' || p === '..')) throw new PathEscapeError(taskId, relativePath);
  return parts.join('/');
}

export async function createTaskWorkspace(root: string, taskId: string): Promise<TaskWorkspace> {
  if (!TASK_ID_RE.test(taskId)) {
    throw new Error(`Invalid task id (must match ${TASK_ID_RE.source}): ${taskId}`);
  }
  const taskRoot = resolve(root, 'tasks', taskId);
  const layout: TaskWorkspace = {
    root: taskRoot,
    taskId,
    inputs: join(taskRoot, 'inputs'),
    outputs: join(taskRoot, 'outputs'),
    tmp: join(taskRoot, 'tmp'),
  };
  for (const area of TASK_LAYOUT) await mkdir(layout[area], { recursive: true });
  return layout;
}

export async function writeTaskFile<T extends TaskArea>(
  ws: TaskWorkspace,
  area: T,
  relativePath: string,
  content: string,
): Promise<string> {
  const safe = assertSafeRelativePath(ws.taskId, relativePath);
  const target = join(ws[area], safe);
  const absoluteDir = target.slice(0, target.length - safe.length);
  await mkdir(absoluteDir, { recursive: true });
  await writeFile(target, content, 'utf8');
  return target;
}

export function resolveInTask<T extends TaskArea>(ws: TaskWorkspace, area: T, relativePath: string): string {
  return join(ws[area], assertSafeRelativePath(ws.taskId, relativePath));
}

/**
 * Guards the assumption that a resolved path is still inside the task tree.
 * Used as a defensive check before any derived service touches an artifact.
 */
export function assertInsideTask(ws: TaskWorkspace, absolutePath: string): void {
  const resolved = resolve(absolutePath);
  if (resolved !== ws.root && !resolved.startsWith(ws.root + sep)) {
    throw new PathEscapeError(ws.taskId, absolutePath);
  }
}

/** Always POSIX-style relative paths, so artifact ids are stable across OSes. */
export async function listArtifacts(ws: TaskWorkspace): Promise<string[]> {
  const found: string[] = [];
  for (const area of TASK_LAYOUT) {
    const entries = await readdir(ws[area], { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const parent = (entry.parentPath ?? '') as string;
      const relativeDir = parent.slice(ws[area].length).replace(/^[/\\]+/, '');
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      found.push(`${area}/${relativePath.split(/[/\\]+/).join('/')}`);
    }
  }
  return found.sort();
}

export async function disposeTaskWorkspace(ws: TaskWorkspace): Promise<void> {
  await rm(ws.root, { recursive: true, force: true });
}
