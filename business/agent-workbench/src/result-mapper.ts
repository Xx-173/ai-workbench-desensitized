/**
 * Vendor-neutral Agent result mapping.
 *
 * Different runtimes return very different shapes: Dify often puts text under
 * `data.outputs`, Coze may use `output`, and a local script may simply print a
 * JSON object.  Craft needs one predictable, safe shape to render in chat and
 * in the native workbench page.
 */

import type { JsonValue } from './ports.ts';

export interface MappedAgentResult {
  readonly text: string | null;
  readonly artifacts: readonly string[];
  /** Safe structured data for consumers that need the full vendor response. */
  readonly data: JsonValue;
  readonly truncated: boolean;
}

const SECRET_KEY = /(api[_-]?key|authorization|token|secret|password|credential)/i;
const TEXT_KEY = /^(answer|text|output|content|message|result)$/i;
const ARTIFACT_KEY = /^(url|uri|audio_url|video_url|image_url|file_url|download_url)$/i;
const MAX_RENDERED_CHARS = 64_000;

function isRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Remove accidental credential echoes before an upstream result reaches UI/chat. */
export function redactAgentResult(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(redactAgentResult);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    SECRET_KEY.test(key) ? '[REDACTED]' : redactAgentResult(child),
  ])) as JsonValue;
}

function collect(value: JsonValue, texts: string[], artifacts: Set<string>, depth = 0): void {
  if (depth > 7) return;
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value)) artifacts.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collect(item, texts, artifacts, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'string' && TEXT_KEY.test(key) && child.trim()) texts.push(child.trim());
    if (typeof child === 'string' && ARTIFACT_KEY.test(key) && /^https?:\/\//i.test(child)) artifacts.add(child);
    // Dify commonly nests user-facing fields under data/outputs; recurse so
    // no vendor-specific renderer has to be added for each connector.
    collect(child, texts, artifacts, depth + 1);
  }
}

export function mapAgentResult(value: JsonValue): MappedAgentResult {
  const data = redactAgentResult(value);
  const texts: string[] = [];
  const artifacts = new Set<string>();
  collect(data, texts, artifacts);
  const fallback = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  const rendered = texts.length > 0 ? [...new Set(texts)].join('\n\n') : fallback;
  const truncated = rendered.length > MAX_RENDERED_CHARS;
  return {
    text: rendered ? rendered.slice(0, MAX_RENDERED_CHARS) : null,
    artifacts: [...artifacts],
    data,
    truncated,
  };
}
