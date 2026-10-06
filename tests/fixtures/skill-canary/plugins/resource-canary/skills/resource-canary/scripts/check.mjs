#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const directory = dirname(fileURLToPath(import.meta.url));
const reference = await readFile(join(directory, '../references/guide.txt'), 'utf8');
const binary = await readFile(join(directory, '../assets/sample.bin'));
if (!reference.includes('MENOTEAM_SKILL_CANARY_REFERENCE_V1')) throw new Error('Reference marker missing');
const digest = createHash('sha256').update(binary).digest('hex');
process.stdout.write(`MENOTEAM_SKILL_CANARY_V1\n${digest}\n`);
