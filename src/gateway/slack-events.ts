import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { AgentRouter, GatewayError, type SlackOrigin } from './router.js';

export interface SlackEventsOptions {
  signingSecret: string;
  botUserId: string;
  allowedUserIds: string[];
  allowedChannelIds: string[];
  masterEndpointId: string;
  router: AgentRouter;
  postThreadMessage: (channelId: string, threadTs: string, text: string) => Promise<void>;
  now?: () => number;
}

interface SlackEvent {
  type?: string;
  subtype?: string;
  bot_id?: string;
  user?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
  text?: string;
}

export function registerSlackEvents(app: FastifyInstance, options: SlackEventsOptions): void {
  const allowedUsers = new Set(options.allowedUserIds);
  const allowedChannels = new Set(options.allowedChannelIds);
  const seenEventIds = new Set<string>();
  const now = options.now ?? Date.now;

  app.post('/slack/events', async (request, reply) => {
    const rawBody = request.body;
    if (!Buffer.isBuffer(rawBody)) return reply.code(400).send({ error: 'Invalid Slack request' });
    if (!verifySlackRequest(rawBody, request.headers, options.signingSecret, now())) {
      return reply.code(401).send({ error: 'Invalid Slack signature' });
    }
    const payload = parseSlackBody(rawBody);
    if (payload.type === 'url_verification') return reply.send({ challenge: payload.challenge });
    if (payload.type !== 'event_callback' || typeof payload.event_id !== 'string') return reply.send({ ok: true });
    if (seenEventIds.has(payload.event_id)) return reply.send({ ok: true });
    seenEventIds.add(payload.event_id);
    if (seenEventIds.size > 2_000) seenEventIds.delete(seenEventIds.values().next().value!);
    const mention = normalizeSlackMention(payload.event as SlackEvent | undefined, {
      botUserId: options.botUserId,
      allowedUsers,
      allowedChannels,
    });
    if (mention) {
      setImmediate(() => {
        void routeMention(mention, options).catch(() => undefined);
      });
    }
    return reply.send({ ok: true });
  });
}

export function verifySlackRequest(
  body: Buffer,
  headers: Record<string, string | string[] | undefined>,
  signingSecret: string,
  nowMs: number,
): boolean {
  const timestamp = firstHeader(headers['x-slack-request-timestamp']);
  const signature = firstHeader(headers['x-slack-signature']);
  if (!timestamp || !signature || !/^\d+$/u.test(timestamp)) return false;
  if (Math.abs(Math.floor(nowMs / 1_000) - Number(timestamp)) > 5 * 60) return false;
  const expected = `v0=${createHmac('sha256', signingSecret).update(`v0:${timestamp}:`).update(body).digest('hex')}`;
  return secretMatches(signature, expected);
}

export function normalizeSlackMention(
  event: SlackEvent | undefined,
  options: { botUserId: string; allowedUsers: Set<string>; allowedChannels: Set<string> },
): ({ prompt?: string; error?: string } & SlackOrigin) | null {
  if (!event || event.type !== 'app_mention' || event.bot_id || event.subtype || event.user === options.botUserId) return null;
  if (!event.user || !event.channel || !event.ts || !options.allowedUsers.has(event.user) || !options.allowedChannels.has(event.channel)) return null;
  const origin = { channelId: event.channel, threadTs: event.thread_ts ?? event.ts };
  const prompt = String(event.text ?? '').replaceAll(`<@${options.botUserId}>`, ' ').replace(/\s+/gu, ' ').trim();
  if (!prompt) return { ...origin, error: 'Please include a request after mentioning Master.' };
  if (prompt.length > 12_000) return { ...origin, error: 'That request is too long (maximum 12,000 characters).' };
  return { ...origin, prompt };
}

async function routeMention(
  mention: ({ prompt?: string; error?: string } & SlackOrigin),
  options: SlackEventsOptions,
): Promise<void> {
  if (mention.error) {
    await options.postThreadMessage(mention.channelId, mention.threadTs, `*MASTER*\n${mention.error}`);
    return;
  }
  try {
    options.router.route(options.masterEndpointId, mention.prompt!, {
      channelId: mention.channelId,
      threadTs: mention.threadTs,
    });
  } catch (error) {
    const message = error instanceof GatewayError && error.code === 'OFFLINE'
      ? 'Master is offline right now.'
      : error instanceof GatewayError && error.code === 'CONFLICT'
        ? 'Master is handling another request. Please try again shortly.'
        : 'Master could not route that request.';
    await options.postThreadMessage(mention.channelId, mention.threadTs, `*MASTER*\n${message}`);
  }
}

function parseSlackBody(body: Buffer): Record<string, unknown> {
  try {
    const parsed = JSON.parse(body.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
    return parsed as Record<string, unknown>;
  } catch {
    throw new GatewayError('INVALID_ORIGIN', 'Invalid Slack payload');
  }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function secretMatches(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}
