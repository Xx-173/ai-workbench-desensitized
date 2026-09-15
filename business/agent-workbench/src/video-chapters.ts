/**
 * Video chaptering — grouping transcript segments into sections, with a
 * deterministic fallback (resume bullet 2, the self-developed part).
 *
 * The problem this solves is not "call the model". It is that a model is an
 * unreliable participant: it can throw, hang to timeout, return chapters in
 * the wrong order, invent entries outside the video bounds, or drop a
 * section entirely. Naively trusting its output means the result page has no
 * structure at all exactly when the model misbehaves.
 *
 * So the contract here is: **you always get four ordered chapters back.**
 * Either they come from the model, or they come from the arithmetic rule.
 * The caller never has a third state to handle, and the UI never renders an
 * empty page.
 */

import type { TranscriptSegment } from './ports.ts';

export const SECTIONS = ['opening', 'knowledge', 'marketing', 'closing'] as const;

export type SectionKind = (typeof SECTIONS)[number];

export const SECTION_LABELS: Readonly<Record<SectionKind, string>> = {
  opening: '开场',
  knowledge: '知识内容',
  marketing: '营销',
  closing: '收尾',
};

export interface PageHint {
  readonly startSec: number;
  readonly page: number;
}

export interface Chapter {
  readonly section: SectionKind;
  readonly label: string;
  readonly startSec: number;
  readonly endSec: number;
  readonly durationSec: number;
  readonly summary: string;
  /** Derived from optional lecture page hints; absent when no hints supplied. */
  readonly pageRange?: { readonly from: number; readonly to: number };
}

export type FallbackReason =
  | 'no-segments'
  | 'model-threw'
  | 'invalid-shape'
  | 'missing-sections'
  | 'out-of-bounds'
  | 'non-monotonic';

export interface ChapterizeResult {
  readonly chapters: readonly Chapter[];
  readonly source: 'model' | 'rule-fallback';
  readonly reason?: FallbackReason;
  readonly warnings: readonly string[];
}

export interface ChapterizeDeps {
  /** Returns raw, untrusted model output. May throw. Must not be trusted. */
  readonly groupByModel: (segments: readonly TranscriptSegment[]) => Promise<unknown>;
  readonly pageHints?: readonly PageHint[];
  readonly timeoutMs?: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Canonicalizes and bounds-checks whatever the model returned. */
export function normalizeModelChapters(
  raw: unknown,
  bounds: { readonly start: number; readonly end: number },
): { ok: true; chapters: readonly Chapter[] } | { ok: false; reason: FallbackReason; warnings: string[] } {
  const warnings: string[] = [];
  if (!Array.isArray(raw)) return { ok: false, reason: 'invalid-shape', warnings: ['model output is not an array'] };

  const parsed: Chapter[] = [];
  for (const item of raw) {
    if (!isRecord(item)) {
      warnings.push('skipped non-object entry');
      continue;
    }
    const { section, startSec, endSec, summary } = item;
    if (typeof section !== 'string' || !(SECTIONS as readonly string[]).includes(section)) {
      warnings.push(`unknown section "${String(section)}"`);
      continue;
    }
    if (!isFiniteNumber(startSec) || !isFiniteNumber(endSec) || endSec <= startSec) {
      warnings.push(`bad bounds for ${section}`);
      continue;
    }
    if (startSec < bounds.start || endSec > bounds.end) {
      return { ok: false, reason: 'out-of-bounds', warnings: [`${section} exceeds transcript bounds`] };
    }
    parsed.push({
      section: section as SectionKind,
      label: SECTION_LABELS[section as SectionKind],
      startSec,
      endSec,
      durationSec: Number((endSec - startSec).toFixed(3)),
      summary: typeof summary === 'string' ? summary : '',
    });
  }

  const present = new Set(parsed.map((c) => c.section));
  const missing = SECTIONS.filter((s) => !present.has(s));
  if (missing.length > 0) return { ok: false, reason: 'missing-sections', warnings: [`missing ${missing.join(',')}`] };

  const ordered = [...parsed].sort((a, b) => a.startSec - b.startSec);
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i]!.startSec < ordered[i - 1]!.endSec) return { ok: false, reason: 'non-monotonic', warnings: ['overlapping chapters'] };
  }

  return { ok: true, chapters: ordered };
}

/** Always succeeds. Splits the transcript into four equal intervals. */
export function chaptersByEqualIntervals(segments: readonly TranscriptSegment[]): Chapter[] {
  if (segments.length === 0) return [];
  const start = Math.min(...segments.map((s) => s.startSec));
  const end = Math.max(...segments.map((s) => s.endSec));
  const span = (end - start) / SECTIONS.length;
  return SECTIONS.map((section, i) => {
    const startSec = Number((start + span * i).toFixed(3));
    const endSec = Number((start + span * (i + 1)).toFixed(3));
    return {
      section,
      label: SECTION_LABELS[section],
      startSec,
      endSec,
      durationSec: Number((endSec - startSec).toFixed(3)),
      summary: `按时间均分区间生成（${i + 1}/${SECTIONS.length}）`,
    };
  });
}

function pageRangeFor(startSec: number, endSec: number, hints: readonly PageHint[]): { from: number; to: number } | undefined {
  if (hints.length === 0) return undefined;
  const inside = hints
    .filter((h) => h.startSec >= startSec && h.startSec < endSec)
    .map((h) => h.page)
    .sort((a, b) => a - b);
  if (inside.length === 0) return undefined;
  return { from: inside[0]!, to: inside[inside.length - 1]! };
}

function attachPages(chapters: readonly Chapter[], hints: readonly PageHint[] | undefined): Chapter[] {
  if (!hints || hints.length === 0) return [...chapters];
  return chapters.map((c) => ({ ...c, pageRange: pageRangeFor(c.startSec, c.endSec, hints) }));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number | undefined): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('model timeout')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function buildChapters(
  segments: readonly TranscriptSegment[],
  deps: ChapterizeDeps,
): Promise<ChapterizeResult> {
  const hints = deps.pageHints ?? [];

  if (segments.length === 0) {
    return { chapters: [], source: 'rule-fallback', reason: 'no-segments', warnings: [] };
  }

  const bounds = {
    start: Math.min(...segments.map((s) => s.startSec)),
    end: Math.max(...segments.map((s) => s.endSec)),
  };

  try {
    const raw = await withTimeout(deps.groupByModel(segments), deps.timeoutMs);
    const normalized = normalizeModelChapters(raw, bounds);
    if (!normalized.ok) {
      return {
        chapters: attachPages(chaptersByEqualIntervals(segments), hints),
        source: 'rule-fallback',
        reason: normalized.reason,
        warnings: normalized.warnings,
      };
    }
    return { chapters: attachPages(normalized.chapters, hints), source: 'model', warnings: [] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      chapters: attachPages(chaptersByEqualIntervals(segments), hints),
      source: 'rule-fallback',
      reason: 'model-threw',
      warnings: [message],
    };
  }
}
