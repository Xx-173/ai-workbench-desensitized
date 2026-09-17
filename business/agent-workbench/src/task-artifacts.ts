import { readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

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
  createPresignedUploadUrl?(input: {
    workspacePath: string;
    taskId: string;
    area: TaskArtifactArea;
    filename: string;
    mimeType?: string;
    expiresInSeconds?: number;
  }): Promise<{ uploadUrl: string; objectKey: string; artifact: TaskArtifact }>;
}

export function safeArtifactFilename(taskId: string, value: string): string {
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
    const filename = safeArtifactFilename(ws.taskId, input.filename);
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

export interface S3TaskArtifactStoreOptions {
  readonly endpoint?: string;
  readonly region?: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly forcePathStyle?: boolean;
  readonly prefix?: string;
}

/**
 * S3-compatible artifact store for production deployments.
 *
 * `workspacePath` is intentionally reduced to a one-way namespace hash: an
 * absolute server path must never become a public object key. MinIO, Aliyun
 * OSS S3 compatibility and other S3-compatible providers can use the same
 * implementation. Uploads are made by the server today; the HTTP layer can
 * later issue pre-signed URLs without changing this store contract.
 */
export class S3TaskArtifactStore implements TaskArtifactStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(options: S3TaskArtifactStoreOptions) {
    const config: S3ClientConfig = {
      region: options.region ?? 'us-east-1',
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      forcePathStyle: options.forcePathStyle ?? Boolean(options.endpoint),
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
    };
    this.client = new S3Client(config);
    this.bucket = options.bucket;
    this.prefix = (options.prefix ?? 'craft-workbench').replace(/^\/+|\/+$/g, '');
  }

  async put(input: PutTaskArtifactInput): Promise<TaskArtifact> {
    const filename = safeArtifactFilename(input.taskId, input.filename);
    const key = this.objectKey(input.workspacePath, input.taskId, input.area, filename);
    const createdAt = new Date().toISOString();
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: input.bytes,
      ContentType: input.mimeType || 'application/octet-stream',
      Metadata: { taskId: input.taskId, area: input.area, filename },
    }));
    return {
      taskId: input.taskId,
      area: input.area,
      filename,
      relativePath: `${input.area}/${filename}`,
      mimeType: input.mimeType || 'application/octet-stream',
      sizeBytes: input.bytes.byteLength,
      createdAt,
    };
  }

  async createPresignedUploadUrl(input: {
    workspacePath: string;
    taskId: string;
    area: TaskArtifactArea;
    filename: string;
    mimeType?: string;
    expiresInSeconds?: number;
  }): Promise<{ uploadUrl: string; objectKey: string; artifact: TaskArtifact }> {
    const filename = safeArtifactFilename(input.taskId, input.filename);
    const objectKey = this.objectKey(input.workspacePath, input.taskId, input.area, filename);
    const mimeType = input.mimeType || 'application/octet-stream';
    const uploadUrl = await getSignedUrl(this.client as any, new PutObjectCommand({
      Bucket: this.bucket, Key: objectKey, ContentType: mimeType,
      Metadata: { taskId: input.taskId, area: input.area, filename },
    }) as any, { expiresIn: Math.min(Math.max(input.expiresInSeconds ?? 900, 60), 86_400) });
    return {
      uploadUrl,
      objectKey,
      artifact: {
        taskId: input.taskId, area: input.area, filename, relativePath: `${input.area}/${filename}`,
        mimeType, sizeBytes: 0, createdAt: new Date().toISOString(),
      },
    };
  }

  async list(workspacePath: string, taskId: string): Promise<TaskArtifact[]> {
    const prefix = `${this.namespace(workspacePath)}/tasks/${taskId}/`;
    const result = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix }));
    const artifacts: TaskArtifact[] = [];
    for (const item of result.Contents ?? []) {
      if (!item.Key || !item.Size && item.Size !== 0) continue;
      const parsed = this.parseKey(item.Key);
      if (!parsed || parsed.taskId !== taskId) continue;
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: item.Key }));
      artifacts.push({
        taskId,
        area: parsed.area,
        filename: parsed.filename,
        relativePath: `${parsed.area}/${parsed.filename}`,
        mimeType: head.ContentType ?? 'application/octet-stream',
        sizeBytes: Number(item.Size ?? head.ContentLength ?? 0),
        createdAt: (item.LastModified ?? new Date()).toISOString(),
      });
    }
    return artifacts.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  }

  async read(workspacePath: string, taskId: string, area: TaskArtifactArea, filename: string): Promise<{ artifact: TaskArtifact; bytes: Buffer } | null> {
    const safe = safeArtifactFilename(taskId, filename);
    const key = this.objectKey(workspacePath, taskId, area, safe);
    try {
      const [head, object] = await Promise.all([
        this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key })),
        this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key })),
      ]);
      if (!object.Body) return null;
      const bytes = Buffer.from(await object.Body.transformToByteArray());
      return {
        artifact: {
          taskId, area, filename: safe, relativePath: `${area}/${safe}`,
          mimeType: head.ContentType ?? 'application/octet-stream',
          sizeBytes: Number(head.ContentLength ?? bytes.byteLength),
          createdAt: (head.LastModified ?? new Date()).toISOString(),
        },
        bytes,
      };
    } catch (error) {
      const code = (error as { name?: string }).name;
      if (code === 'NotFound' || code === 'NoSuchKey' || code === 'NotFoundException') return null;
      throw error;
    }
  }

  private namespace(workspacePath: string): string {
    const digest = createHash('sha256').update(workspacePath).digest('hex').slice(0, 24);
    return `${this.prefix}/ws-${digest}`;
  }

  private objectKey(workspacePath: string, taskId: string, area: TaskArtifactArea, filename: string): string {
    return `${this.namespace(workspacePath)}/tasks/${taskId}/${area}/${filename}`;
  }

  private parseKey(key: string): { taskId: string; area: TaskArtifactArea; filename: string } | null {
    const marker = '/tasks/';
    const index = key.indexOf(marker);
    if (index < 0) return null;
    const parts = key.slice(index + marker.length).split('/');
    const taskId = parts.shift();
    const area = parts.shift();
    if ((area !== 'inputs' && area !== 'outputs' && area !== 'tmp') || !taskId || parts.length === 0) return null;
    return { taskId, area, filename: parts.join('/') };
  }
}
