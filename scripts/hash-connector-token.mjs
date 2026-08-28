#!/usr/bin/env node
import { createHash } from 'node:crypto';

const token = process.env.MENOTEAM_AGENT_TOKEN;
if (!token || token.length < 32 || /replace|example/iu.test(token)) {
  process.stderr.write('MENOTEAM_AGENT_TOKEN is missing or invalid\n');
  process.exitCode = 1;
} else {
  process.stdout.write(`${createHash('sha256').update(token).digest('hex')}\n`);
}
