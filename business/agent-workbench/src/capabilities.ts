/**
 * First-party sample agents used to demonstrate the registration surface.
 *
 * Upstream services (third-party voice cloning, third-party video parsing,
 * and the low-code workflows) are external integrations, not in-house models.
 * Nothing here ships with a real endpoint or key; see
 * `config/agents.example.json`. New external agents normally use manifests
 * instead of requiring a source-code change in this file.
 */

import type { CapabilityEntry } from './capability-registry.ts';
import type { JsonObject, JsonValue, ToolContext, TranscriptSegment } from './ports.ts';
import { callRemoteService, type FetchLike } from './remote.ts';
import { createTaskWorkspace, writeTaskFile } from './task-workspace.ts';
import { buildChapters, type Chapter } from './video-chapters.ts';

/** Test seam. Default is the platform's fetch; tests swap it out. */
let activeFetch: FetchLike = globalThis.fetch as unknown as FetchLike;

export function setFetchImpl(impl: FetchLike): void {
  activeFetch = impl;
}

export function resetFetchImpl(): void {
  activeFetch = globalThis.fetch as unknown as FetchLike;
}

const VOICE_ENDPOINT = {
  baseUrlEnv: 'VOICE_SERVICE_BASE_URL',
  tokenEnv: 'VOICE_SERVICE_TOKEN',
  path: '/v1/voices/clone',
} as const;

const VIDEO_ENDPOINT = {
  baseUrlEnv: 'VIDEO_PARSE_BASE_URL',
  tokenEnv: 'VIDEO_PARSE_TOKEN',
  path: '/v1/videos/analyze',
} as const;

const WORKFLOW_ENDPOINT = {
  baseUrlEnv: 'LOWCODE_WORKFLOW_BASE_URL',
  tokenEnv: 'LOWCODE_WORKFLOW_TOKEN',
  path: '/v1/workflows/run',
} as const;

/**
 * Projects the base's session isolation onto a business task:
 * every task owns `<workspace>/tasks/<taskId>/{inputs,outputs,tmp}`.
 */
async function taskArea(ctx: ToolContext) {
  const taskId = (ctx.taskId ?? ctx.sessionId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
  return createTaskWorkspace(ctx.workspacePath, taskId);
}

async function saveOutput(ctx: ToolContext, name: string, body: string): Promise<string> {
  const ws = await taskArea(ctx);
  return writeTaskFile(ws, 'outputs', name, body);
}

/** Places holdings for page hints: evenly spaced because real hints are page-time pairs. */
function toPageHints(pages: readonly number[] | undefined): { startSec: number; page: number }[] {
  if (!pages || pages.length === 0) return [];
  const step = 60;
  return pages.map((page, index) => ({ startSec: index * step, page }));
}

export const capabilities: readonly CapabilityEntry[] = [
  {
    id: 'voice-clone',
    toolName: 'clone_voice',
    description: '从一段参考音频提取音色并克隆生成目标语音（第三方音色服务，非自研模型）。',
    transport: 'mcp',
    inputSchema: {
      type: 'object',
      properties: {
        referenceAudio: { type: 'string', description: '参考音频文件名（位于当前任务的 inputs/ 下）' },
        targetText: { type: 'string', description: '要合成的文本' },
      },
      required: ['referenceAudio', 'targetText'],
    },
    async invoke(ctx, input) {
      const payload = await callRemoteService(
        ctx.credentials,
        {
          endpoint: VOICE_ENDPOINT,
          buildBody: (i) => ({ reference_audio: i.referenceAudio, text: i.targetText }),
          mapResponse: (json) => json,
        },
        input,
        activeFetch,
      );
      const audioRef = typeof payload.audio_ref === 'string' ? payload.audio_ref : 'unknown';
      await saveOutput(ctx, 'voice-clone.json', JSON.stringify({ audioRef }, null, 2));
      return { summary: `音色克隆完成，产物引用 ${audioRef}`, artifacts: ['outputs/voice-clone.json'], raw: payload };
    },
  },

  {
    id: 'video-parse',
    toolName: 'parse_video',
    description: '解析视频得到转写分段，并按开场/知识内容/营销/收尾聚合为章节。',
    transport: 'in-process',
    inputSchema: {
      type: 'object',
      properties: {
        videoFile: { type: 'string', description: '视频文件名（位于当前任务的 inputs/ 下）' },
        pages: { type: 'array', description: '可选，讲义页码序列', items: { type: 'number' } },
      },
      required: ['videoFile'],
    },
    async invoke(ctx, input) {
      // 1) third-party transcription — an external service, not an in-house model.
      const parsed = await callRemoteService(
        ctx.credentials,
        {
          endpoint: VIDEO_ENDPOINT,
          buildBody: (i) => ({ video: i.videoFile, with_timestamps: true }),
          mapResponse: (json) => json,
        },
        input,
        activeFetch,
      );
      const segments = ((parsed.segments as JsonObject[] | undefined) ?? []) as unknown as TranscriptSegment[];

      // 2) self-developed business logic: section grouping + deterministic fallback.
      const result = await buildChapters(segments, {
        pageHints: toPageHints(input.pages as number[] | undefined),
        timeoutMs: 10_000,
        groupByModel: async () => {
          const grouped = await callRemoteService(
            ctx.credentials,
            {
              endpoint: WORKFLOW_ENDPOINT,
              buildBody: () => ({ workflow: 'video-chapters', segments: segments as unknown as JsonValue }),
              mapResponse: (json) => json,
            },
            input,
            activeFetch,
          );
          return grouped.chapters as unknown;
        },
      });

      const body = JSON.stringify(result, null, 2);
      await saveOutput(ctx, 'chapters.json', body);
      const how = result.source === 'model' ? '模型聚合' : '规则回退';
      return {
        summary: `视频解析完成：${(result.chapters as readonly Chapter[]).length} 个章节（${how}）`,
        artifacts: ['outputs/chapters.json'],
        raw: result as never,
      };
    },
  },

  {
    id: 'script-clean',
    toolName: 'clean_script',
    description: '对课程话术/脚本做清洗与规范化（低代码工作流）。',
    transport: 'in-process',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '待清洗文本' },
      },
      required: ['text'],
    },
    async invoke(ctx, input) {
      const json = await callRemoteService(
        ctx.credentials,
        {
          endpoint: WORKFLOW_ENDPOINT,
          buildBody: (i) => ({ workflow: 'script-clean', input: i.text }),
          mapResponse: (j) => j,
        },
        input,
        activeFetch,
      );
      const cleaned = typeof json.cleaned === 'string' ? json.cleaned : '';
      await saveOutput(ctx, 'script-clean.txt', cleaned);
      return { summary: `清洗完成（${cleaned.length} 字符）`, artifacts: ['outputs/script-clean.txt'] };
    },
  },

  {
    id: 'text-qc',
    toolName: 'qc_text',
    description: '对文案做质检，返回问题项清单（低代码工作流）。',
    transport: 'in-process',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '待质检文本' },
      },
      required: ['text'],
    },
    async invoke(ctx, input) {
      const json = await callRemoteService(
        ctx.credentials,
        {
          endpoint: WORKFLOW_ENDPOINT,
          buildBody: (i) => ({ workflow: 'text-qc', input: i.text }),
          mapResponse: (j) => j,
        },
        input,
        activeFetch,
      );
      const issues = Array.isArray(json.issues) ? json.issues : [];
      await saveOutput(ctx, 'text-qc.json', JSON.stringify(issues, null, 2));
      return { summary: `质检完成，${issues.length} 个问题项`, artifacts: ['outputs/text-qc.json'] };
    },
  },

  {
    id: 'copywriting',
    toolName: 'generate_copy',
    description: '按给定主题与受众生成营销文案（低代码工作流）。',
    transport: 'in-process',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: '主题' },
        audience: { type: 'string', description: '目标受众' },
        tone: { type: 'string', description: '语气，缺省 neutral' },
      },
      required: ['topic', 'audience'],
    },
    async invoke(ctx, input) {
      const json = await callRemoteService(
        ctx.credentials,
        {
          endpoint: WORKFLOW_ENDPOINT,
          buildBody: (i) => ({
            workflow: 'copywriting',
            topic: i.topic,
            audience: i.audience,
            tone: i.tone ?? 'neutral',
          }),
          mapResponse: (j) => j,
        },
        input,
        activeFetch,
      );
      const copy = typeof json.copy === 'string' ? json.copy : '';
      await saveOutput(ctx, 'copywriting.md', copy);
      return { summary: `文案已生成（${copy.length} 字符）`, artifacts: ['outputs/copywriting.md'] };
    },
  },
];
