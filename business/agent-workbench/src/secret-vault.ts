/**
 * Minimal local secret store for the Control Center.
 *
 * Values are AES-256-GCM encrypted at rest. API/UI callers can see whether a
 * reference is configured, never its stored value. Production deployments may
 * replace this port with Craft's credential manager or an external vault.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const SECRET_NAME = /^[A-Z][A-Z0-9_]{1,127}$/;

export interface SecretStatus {
  readonly name: string;
  readonly configured: true;
  readonly updatedAt: string;
}

interface SecretRecord {
  readonly value: string;
  readonly updatedAt: string;
}

interface EncryptedEnvelope {
  readonly version: 1;
  readonly iv: string;
  readonly tag: string;
  readonly ciphertext: string;
}

function assertSecretName(name: string): void {
  if (!SECRET_NAME.test(name)) throw new Error('Secret reference must be an uppercase identifier');
}

function keyFromBase64(value: string): Buffer {
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error('Secret store master key must be a base64-encoded 32-byte value');
  return key;
}

export class EncryptedFileSecretVault {
  private readonly path: string;
  private readonly key: Buffer;
  private readonly values: Map<string, SecretRecord>;

  private constructor(path: string, key: Buffer, values: Readonly<Record<string, SecretRecord>>) {
    this.path = path;
    this.key = key;
    this.values = new Map(Object.entries(values));
  }

  static async open(path: string, masterKeyBase64: string): Promise<EncryptedFileSecretVault> {
    const key = keyFromBase64(masterKeyBase64);
    try {
      const raw = await readFile(path, 'utf8');
      const envelope = JSON.parse(raw) as EncryptedEnvelope;
      if (envelope.version !== 1 || !envelope.iv || !envelope.tag || !envelope.ciphertext) throw new Error('Secret store envelope is invalid');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8');
      const values = JSON.parse(plaintext) as Record<string, SecretRecord>;
      for (const [name, record] of Object.entries(values)) {
        assertSecretName(name);
        if (!record || typeof record.value !== 'string' || typeof record.updatedAt !== 'string') throw new Error('Secret store record is invalid');
      }
      return new EncryptedFileSecretVault(path, key, values);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new EncryptedFileSecretVault(path, key, {});
      throw error;
    }
  }

  read(name: string): string | null {
    return this.values.get(name)?.value ?? null;
  }

  has(name: string): boolean {
    return this.values.has(name);
  }

  list(): readonly SecretStatus[] {
    return [...this.values.entries()]
      .map(([name, record]) => ({ name, configured: true as const, updatedAt: record.updatedAt }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async set(name: string, value: string): Promise<void> {
    assertSecretName(name);
    if (!value) throw new Error('Secret value must not be empty');
    this.values.set(name, { value, updatedAt: new Date().toISOString() });
    await this.persist();
  }

  async delete(name: string): Promise<void> {
    assertSecretName(name);
    this.values.delete(name);
    await this.persist();
  }

  private async persist(): Promise<void> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const plaintext = Buffer.from(JSON.stringify(Object.fromEntries(this.values)), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const envelope: EncryptedEnvelope = {
      version: 1,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(envelope), { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, this.path);
  }
}
