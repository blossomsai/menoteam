import type { AgentReply } from './router.js';

const SLACK_TEXT_LIMIT = 3_900;

export function createSlackReplyPoster(botToken: string): (reply: AgentReply) => Promise<void> {
  if (!botToken.startsWith('xoxb-')) throw new Error('SLACK_BOT_TOKEN must be a bot token');
  const postThreadMessage = createSlackThreadPoster(botToken);
  return async (reply) => {
    const body = reply.status === 'completed' && reply.text?.trim()
      ? reply.text.trim()
      : 'This agent could not complete the request.';
    await postThreadMessage(reply.job.origin.channelId, reply.job.origin.threadTs, `*${reply.endpoint.label}*\n${body}`);
  };
}

export function createSlackThreadPoster(botToken: string): (channelId: string, threadTs: string, text: string) => Promise<void> {
  if (!botToken.startsWith('xoxb-')) throw new Error('SLACK_BOT_TOKEN must be a bot token');
  return async (channelId, threadTs, text) => {
    for (const part of splitSlackText(text)) {
      await slackApi(botToken, 'chat.postMessage', { channel: channelId, thread_ts: threadTs, text: part });
    }
  };
}

export function splitSlackText(text: string, limit = SLACK_TEXT_LIMIT): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit / 2) cut = rest.lastIndexOf(' ', limit);
    if (cut < limit / 2) cut = limit;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

async function slackApi(token: string, method: string, body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const result = await response.json() as { ok?: boolean };
  if (!response.ok || !result.ok) throw new Error(`Slack API ${method} failed`);
}
