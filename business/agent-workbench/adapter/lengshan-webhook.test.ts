import assert from 'node:assert/strict';
import test from 'node:test';
import { EventDeduper, parseLengshanInbound, signLengshanPayload, verifyLengshanSignature } from './lengshan-webhook.ts';

test('Lengshan boundary validates normalized inbound messages and preserves attachments', () => {
  const message = parseLengshanInbound({
    eventId: 'evt-1', tenantId: 'tenant-1', userId: 'user-1', departmentId: 'sales', text: 'hello',
    attachments: [{ type: 'image', url: 'https://lengshan.example/media/a.jpg', name: 'a.jpg' }],
  });
  assert.equal(message.userId, 'user-1');
  assert.equal(message.attachments?.[0]?.type, 'image');
});

test('Lengshan signatures are verified without accepting a modified body', () => {
  const body = JSON.stringify({ eventId: 'evt-1', text: 'hello' });
  const signature = signLengshanPayload(body, 'test-secret');
  assert.equal(verifyLengshanSignature(body, signature, 'test-secret'), true);
  assert.equal(verifyLengshanSignature(`${body}x`, signature, 'test-secret'), false);
});

test('event dedupe accepts once and rejects replay until expiry', () => {
  const dedupe = new EventDeduper(100);
  assert.equal(dedupe.accept('evt-1', 1_000), true);
  assert.equal(dedupe.accept('evt-1', 1_050), false);
  assert.equal(dedupe.accept('evt-1', 1_101), true);
});
