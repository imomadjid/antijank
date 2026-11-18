// Builds skills/antijank/scripts/probe.min.js from probe.js: the copy agents paste or load
// from a CDN when their browser tool can only evaluate JavaScript text.
// It also pins SKILL.md's CDN loader to this version and the new file's integrity hash.
// Run: pnpm build. test/build.test.mjs fails when either is out of date.
import { transform } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = join(dirname(fileURLToPath(import.meta.url)), '../skills/antijank/scripts');
export const SOURCE = join(dir, 'probe.js');
export const MINIFIED = join(dir, 'probe.min.js');
const SKILL = join(dir, '../SKILL.md');
const PKG = join(dir, '../../../package.json');

export async function minify() {
  const { code } = await transform(readFileSync(SOURCE, 'utf8'), {
    minify: true,
    legalComments: 'inline', // keeps the /*! antijank … MIT … */ header
    target: 'chrome110',
  });
  return code;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const code = await minify();
  writeFileSync(MINIFIED, code);
  const { version } = JSON.parse(readFileSync(PKG, 'utf8'));
  const sri = 'sha384-' + createHash('sha384').update(code).digest('base64');
  const skill = readFileSync(SKILL, 'utf8')
    .replace(/(cdn\.jsdelivr\.net\/npm\/antijank@)[^/]+/, `$1${version}`)
    .replace(/(s\.integrity = ')[^']+/, `$1${sri}`);
  writeFileSync(SKILL, skill);
  console.log(`probe.min.js: ${(code.length / 1024).toFixed(1)} KB, ${sri}`);
}
