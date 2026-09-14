/**
 * Thin helper for calling third-party AI services.
 *
 * DESENSITIZATION CONTRACT (do not weaken this):
 *  - No endpoint, key, project id or account name appears in this file.
 *  - Every value comes from the injection `CredentialReader`, whose only
 *    default behaviour is to return `null`.
 *  - When configuration is absent we fail loudly naming the placeholder names
 *    instead of silently routing traffic anywhere.
 */

import type { CredentialReader, JsonObject } from './ports.ts';

export interface RemoteEndpoint {
  /** Placeholder names, e.g. `VOICE_SERVICE_BASE_URL` / `VOICE_SERVICE_TOKEN`. */
  readonly baseUrlEnv: string;
  readonly tokenEnv: string;
  readonly path: string;
}

export interface RemoteCallSpec<TInput extends JsonObject> {
  readonly endpoint: RemoteEndpoint;
  readonly buildBody: (input: TInput) => JsonObject;
  readonly buildHeaders?: (input: TInput, token: string) => Record<string, string>;
  readonly mapResponse: (payload: JsonObject) => JsonObject;
}

export class MisconfiguredError extends Error {
  readonly missingEnvNames: readonly string[];
  constructor(missingEnvNames: readonly string[]) {
    super(`Missing required configuration: ${missingEnvNames.join(', ')}`);
    this.name = 'MisconfiguredError';
    this.missingEnvNames = missingEnvNames;
  }
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

/**
 * Resolves endpoint + credential from injected sources only.
 * Returns nothing usable when anything is missing.
 */
export function resolveEndpoint(credentials: CredentialReader, endpoint: RemoteEndpoint): { baseUrl: string; token: string } {
  const missing: string[] = [];
  const baseUrl = credentials.read(endpoint.baseUrlEnv);
  const token = credentials.read(endpoint.tokenEnv);
  if (!baseUrl) missing.push(endpoint.baseUrlEnv);
  if (!token) missing.push(endpoint.tokenEnv);
  if (missing.length > 0) throw new MisconfiguredError(missing);
  return { baseUrl: baseUrl as string, token: token as string };
}

export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

export async function callRemoteService<TInput extends JsonObject>(
  credentials: CredentialReader,
  spec: RemoteCallSpec<TInput>,
  input: TInput,
  fetchImpl: FetchLike,
): Promise<JsonObject> {
  const { baseUrl, token } = resolveEndpoint(credentials, spec.endpoint);
  const url = joinUrl(baseUrl, spec.endpoint.path);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
    ...(spec.buildHeaders?.(input, token) ?? {}),
  };
  const res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(spec.buildBody(input)) });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Upstream ${res.status}: ${detail.slice(0, 200)}`);
  }
  return spec.mapResponse((await res.json()) as JsonObject);
}
