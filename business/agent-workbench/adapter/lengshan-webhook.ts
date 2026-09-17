/**
 * Provider-neutral Lengshan/WeCom message boundary.
 *
 * Lengshan remains the transport layer: it receives/sends WeCom messages and
 * calls this adapter with a normalized event. The workbench only needs to
 * decide which Agent to run and return a normalized reply. Provider-specific
 * field names can therefore be mapped in one place when Lengshan's contract is
 * available, without leaking WeCom credentials into Agent manifests.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface LengshanAttachment {
  readonly type: 'image' | 'file' | 'audio' | 'video';
  readonly url: string;
  readonly name?: string;
}

export interface LengshanInboundMessage {
  readonly eventId: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly departmentId?: string;
  readonly conversationId?: string;
  readonly text: string;
  readonly attachments?: readonly LengshanAttachment[];
  readonly receivedAt?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface LengshanOutboundMessage {
  readonly eventId: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly conversationId?: string;
  readonly text: string;
  readonly attachments?: readonly LengshanAttachment[];
  readonly tags?: readonly string[];
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`Lengshan webhook ${field} is required`);
  return value.trim();
}

function parseAttachment(value: unknown, index: number): LengshanAttachment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Lengshan webhook attachments[${index}] is invalid`);
  const item = value as Record<string, unknown>;
  const type = item.type;
  if (type !== 'image' && type !== 'file' && type !== 'audio' && type !== 'video') throw new Error(`Lengshan webhook attachments[${index}].type is invalid`);
  return {
    type,
    url: nonEmpty(item.url, `attachments[${index}].url`),
    ...(item.name === undefined ? {} : { name: nonEmpty(item.name, `attachments[${index}].name`) }),
  };
}

/** Validate the small normalized contract before routing to an Agent. */
export function parseLengshanInbound(value: unknown): LengshanInboundMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Lengshan webhook body must be an object');
  const body = value as Record<string, unknown>;
  const attachments = body.attachments === undefined
    ? undefined
    : Array.isArray(body.attachments) ? body.attachments.map(parseAttachment) : (() => { throw new Error('Lengshan webhook attachments must be an array'); })();
  return {
    eventId: nonEmpty(body.eventId, 'eventId'),
    tenantId: nonEmpty(body.tenantId, 'tenantId'),
    userId: nonEmpty(body.userId, 'userId'),
    ...(body.departmentId === undefined ? {} : { departmentId: nonEmpty(body.departmentId, 'departmentId') }),
    ...(body.conversationId === undefined ? {} : { conversationId: nonEmpty(body.conversationId, 'conversationId') }),
    text: nonEmpty(body.text, 'text'),
    ...(attachments?.length ? { attachments } : {}),
    ...(body.receivedAt === undefined ? {} : { receivedAt: nonEmpty(body.receivedAt, 'receivedAt') }),
    ...(body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata) ? { metadata: Object.fromEntries(Object.entries(body.metadata).map(([key, item]) => [key, nonEmpty(item, `metadata.${key}`)])) } : {}),
  };
}

/** HMAC helper for a reverse proxy or Lengshan callback signing contract. */
export function signLengshanPayload(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

export function verifyLengshanSignature(rawBody: string, signature: string, secret: string): boolean {
  if (!signature || !secret) return false;
  const expected = Buffer.from(signLengshanPayload(rawBody, secret), 'utf8');
  const received = Buffer.from(signature.trim(), 'utf8');
  return expected.length === received.length && timingSafeEqual(expected, received);
}

/** Minimal replay protection; production deployments should back this by Redis/PostgreSQL. */
export class EventDeduper {
  private readonly seen = new Map<string, number>();
  private readonly ttlMs: number;

  constructor(ttlMs = 10 * 60_000) {
    this.ttlMs = ttlMs;
  }

  accept(eventId: string, now = Date.now()): boolean {
    for (const [key, expiresAt] of this.seen) if (expiresAt <= now) this.seen.delete(key);
    if (this.seen.has(eventId)) return false;
    this.seen.set(eventId, now + this.ttlMs);
    return true;
  }
}
