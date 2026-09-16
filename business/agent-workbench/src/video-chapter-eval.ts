/**
 * Fixed-input evaluation for the chapter fallback contract.
 *
 * The trace contains decisions and assertions, not transcript text. It can be
 * uploaded as a CI artifact and reviewed as evidence that a model failure does
 * not remove the four-section result contract.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { TranscriptSegment } from './ports.ts';
import { SECTIONS, buildChapters, type ChapterizeResult, type FallbackReason } from './video-chapters.ts';

export interface VideoChapterEvalCase {
  readonly id: string;
  readonly segments: readonly TranscriptSegment[];
  readonly groupByModel: () => Promise<unknown>;
  readonly expected: {
    readonly source: ChapterizeResult['source'];
    readonly reason?: FallbackReason;
  };
}

export interface VideoChapterTrace {
  readonly caseId: string;
  readonly source: ChapterizeResult['source'];
  readonly reason?: FallbackReason;
  readonly chapterSections: readonly string[];
  readonly contiguous: boolean;
  readonly expected: VideoChapterEvalCase['expected'];
  readonly passed: boolean;
}

export interface VideoChapterEvalReport {
  readonly suite: 'video-chapter-fallback';
  readonly version: 1;
  readonly generatedAt: string;
  readonly passed: boolean;
  readonly traces: readonly VideoChapterTrace[];
}

function contiguous(result: ChapterizeResult): boolean {
  if (result.chapters.length !== SECTIONS.length) return false;
  return result.chapters.every((chapter, index) => chapter.section === SECTIONS[index]
    && (index === 0 || chapter.startSec === result.chapters[index - 1]!.endSec));
}

export async function runVideoChapterEval(cases: readonly VideoChapterEvalCase[], generatedAt = new Date().toISOString()): Promise<VideoChapterEvalReport> {
  const traces = await Promise.all(cases.map(async (item) => {
    const result = await buildChapters(item.segments, { groupByModel: () => item.groupByModel() });
    const chapterSections = result.chapters.map((chapter) => chapter.section);
    const isContiguous = contiguous(result);
    const passed = result.source === item.expected.source
      && result.reason === item.expected.reason
      && (result.source === 'model' || isContiguous);
    return {
      caseId: item.id,
      source: result.source,
      ...(result.reason ? { reason: result.reason } : {}),
      chapterSections,
      contiguous: isContiguous,
      expected: item.expected,
      passed,
    };
  }));
  return { suite: 'video-chapter-fallback', version: 1, generatedAt, passed: traces.every((trace) => trace.passed), traces };
}

export async function writeVideoChapterEvalArtifact(path: string, report: VideoChapterEvalReport): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}
