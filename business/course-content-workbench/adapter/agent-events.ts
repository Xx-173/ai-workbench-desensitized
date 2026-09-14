/**
 * Business event → base event vocabulary.
 *
 * The point of this file is what it does NOT contain: there is no second event
 * vocabulary, no translation table, no parallel recovery strategy. The
 * business layer emits member names that already exist in the base's
 * `AgentEvent` union, so an error is an `error` and completion is a `complete`
 * regardless of which tool produced them. The renderer's existing branches
 * therefore work untouched.
 *
 * Upstream contract, verified by the guard test:
 *   packages/core/src/types/message.ts @ v0.13.3  →  `export type AgentEvent =`
 *   21 union members. We emit 6 of them; all 6 are real members, not lookalikes.
 *
 * One lived reality worth knowing: that union contains a `pi_turn_anchor`
 * member — a backend-specific event that leaked into the shared contract.
 * Proof that event normalisation is never perfectly clean, and the reason this
 * file stays minimal rather than inventing "our own" events.
 */

import type { WorkbenchEvent } from '../src/business-events.ts';

/**
 * The AgentEvent members this layer emits, transcribed from the upstream union.
 * Kept structurally identical so assignment to the real union is a no-op.
 */
export type BaseAgentEventMember =
  | { readonly type: 'status'; readonly message: string }
  | { readonly type: 'text_delta'; readonly text: string; readonly turnId?: string; readonly parentToolUseId?: string }
  | {
      readonly type: 'tool_start';
      readonly toolName: string;
      readonly toolUseId: string;
      readonly input: unknown;
      readonly turnId?: string;
      readonly parentToolUseId?: string;
    }
  | {
      readonly type: 'tool_result';
      readonly toolUseId: string;
      readonly toolName?: string;
      readonly result: string;
      readonly isError: boolean;
      readonly turnId?: string;
      readonly parentToolUseId?: string;
    }
  | { readonly type: 'error'; readonly message: string; readonly turnId?: string }
  | { readonly type: 'complete'; readonly turnId?: string };

export const EMITTED_EVENT_TYPES = [
  'status',
  'text_delta',
  'tool_start',
  'tool_result',
  'error',
  'complete',
] as const;

/**
 * Identity mapping for the members we produce. It exists so a future change of
 * business vocabulary has exactly one place to be reconciled with the base,
 * and so that reconciliation is a type error, not a runtime surprise.
 */
export function toAgentEvent(event: WorkbenchEvent): BaseAgentEventMember {
  switch (event.type) {
    case 'status':
      return { type: 'status', message: event.message };
    case 'text_delta':
      return { type: 'text_delta', text: event.text, ...(event.turnId ? { turnId: event.turnId } : {}) };
    case 'tool_start':
      return {
        type: 'tool_start',
        toolName: event.toolName,
        toolUseId: event.toolUseId,
        input: event.input,
        ...(event.turnId ? { turnId: event.turnId } : {}),
      };
    case 'tool_result':
      return {
        type: 'tool_result',
        toolUseId: event.toolUseId,
        result: event.result,
        isError: event.isError,
        ...(event.toolName ? { toolName: event.toolName } : {}),
        ...(event.turnId ? { turnId: event.turnId } : {}),
      };
    case 'error':
      return { type: 'error', message: event.message, ...(event.turnId ? { turnId: event.turnId } : {}) };
    case 'complete':
      return { type: 'complete', ...(event.turnId ? { turnId: event.turnId } : {}) };
  }
}
