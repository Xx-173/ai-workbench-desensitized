/**
 * Fixtures. Everything here is synthetic — no real endpoint, credential,
 * account name, course title or media file appears anywhere in this package.
 */

import type { CredentialReader } from '../ports.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Values are placeholders; a real deployment injects them from its vault. */
export const PLACEHOLDER_SECRETS: Readonly<Record<string, string>> = {
  VOICE_SERVICE_BASE_URL: 'https://voice.example.invalid',
  VOICE_SERVICE_TOKEN: 'PLACEHOLDER_VOICE_TOKEN',
  VIDEO_PARSE_BASE_URL: 'https://video.example.invalid',
  VIDEO_PARSE_TOKEN: 'PLACEHOLDER_VIDEO_TOKEN',
  LOWCODE_WORKFLOW_BASE_URL: 'https://workflow.example.invalid',
  LOWCODE_WORKFLOW_TOKEN: 'PLACEHOLDER_WORKFLOW_TOKEN',
};

export function fakeCredentials(overrides: Readonly<Record<string, string | null>> = {}): CredentialReader {
  const merged: Record<string, string | null> = { ...PLACEHOLDER_SECRETS, ...overrides };
  return { read: (name) => merged[name] ?? null };
}

/** A credential reader with nothing configured, to prove fail-loud behaviour. */
export const emptyCredentials: CredentialReader = { read: () => null };

export interface FakeResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}

export interface FakeFetchOptions {
  /** Maps request path suffix → response body. Unmatched paths yield 404. */
  routes: Readonly<Record<string, unknown>>;
  failures?: Readonly<Record<string, number>>;
  calls?: { url: string; method: string; body: unknown }[];
}

export function fakeFetch(options: FakeFetchOptions) {
  const calls = options.calls ?? [];
  return {
    calls,
    async fetch(url: string, init: { method: string; headers: Record<string, string>; body: string }) {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      calls.push({ url, method: init.method, body });
      const matched = Object.keys(options.routes).find((suffix) => url.endsWith(suffix));
      const failure = matched ? options.failures?.[matched] : undefined;
      const response: FakeResponse = {
        ok: !failure && Boolean(matched),
        status: failure ?? (matched ? 200 : 404),
        json: async () => (matched ? options.routes[matched] : {}),
        text: async () => (failure ? `upstream failure ${failure}` : ''),
      };
      return response;
    },
  };
}

export async function withTempWorkspace<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'cwb-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Synthetic transcript — six 30-second slices, 180s total. */
export const SYNTHETIC_SEGMENTS = [
  { startSec: 0, endSec: 30, text: '欢迎来到本节课程' },
  { startSec: 30, endSec: 60, text: '先介绍今天的概念' },
  { startSec: 60, endSec: 90, text: '概念展开与例子' },
  { startSec: 90, endSec: 120, text: '再看一个案例' },
  { startSec: 120, endSec: 150, text: '课程配套资料已经上线' },
  { startSec: 150, endSec: 180, text: '本节到此结束' },
] as const;
