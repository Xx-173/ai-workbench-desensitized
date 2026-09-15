/**
 * Business event vocabulary for long-running tasks.
 *
 * Why reuse this shape instead of inventing one: the renderer and error
 * recovery paths upstream already branch on these member names. Emitting the
 * SAME members means the business layer needs no second recovery strategy —
 * an error is an `error` event, completion is a `complete` event, regardless
 * of which tool produced it.
 *
 * Scope note: this is the business-side usage of the contract. The event
 * adapter itself belongs to the base and is not reimplemented here.
 */

export type WorkbenchEvent =
  | { readonly type: 'status'; readonly message: string }
  | { readonly type: 'text_delta'; readonly text: string; readonly turnId?: string }
  | {
      readonly type: 'tool_start';
      readonly toolName: string;
      readonly toolUseId: string;
      readonly input: unknown;
      readonly turnId?: string;
    }
  | {
      readonly type: 'tool_result';
      readonly toolUseId: string;
      readonly toolName?: string;
      readonly result: string;
      readonly isError: boolean;
      readonly turnId?: string;
    }
  | { readonly type: 'error'; readonly message: string; readonly turnId?: string }
  | { readonly type: 'complete'; readonly turnId?: string };

export type EventSink = (event: WorkbenchEvent) => void;

export interface TaskRunIds {
  readonly turnId: string;
}

/**
 * Wraps one tool invocation in start → result|error events.
 *
 * The important property: a thrown exception never becomes an unhandled
 * rejection upstream. It is converted into a structured `error` event so the
 * UI can offer recovery instead of losing the stream.
 */
export async function runWithEvents<T>(
  sink: EventSink,
  turnId: string,
  toolName: string,
  toolUseId: string,
  input: unknown,
  execute: () => Promise<T>,
  serialize: (value: T) => string,
): Promise<T | null> {
  sink({ type: 'tool_start', toolName, toolUseId, input, turnId });
  try {
    const value = await execute();
    sink({ type: 'tool_result', toolUseId, toolName, result: serialize(value), isError: false, turnId });
    return value;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sink({ type: 'error', message, turnId });
    sink({ type: 'tool_result', toolUseId, toolName, result: message, isError: true, turnId });
    return null;
  } finally {
    sink({ type: 'complete', turnId });
  }
}

/** Turns a percentage into a throttled status stream for long tasks. */
export function createProgressReporter(sink: EventSink, turnId: string, stepMs = 0): (pct: number) => void {
  let last = -1;
  let lastAt = -Infinity;
  return (pct: number) => {
    const clamped = Math.max(0, Math.min(100, Math.round(pct)));
    const now = Date.now();
    if (clamped === last) return;
    if (stepMs > 0 && now - lastAt < stepMs) return;
    last = clamped;
    lastAt = now;
    sink({ type: 'status', message: `progress:${clamped}%` });
  };
}
