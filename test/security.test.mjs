import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const textExtensions = new Set(['.css', '.html', '.js', '.json', '.md', '.mjs', '.ps1', '.sql', '.txt']);
const credentialPatterns = [
  ['Telegram bot token', /\b\d{8,}:[A-Za-z0-9_-]{30,}\b/],
  ['OpenAI-style API key', /\bsk-[A-Za-z0-9]{32,}\b/],
  ['GitHub access token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['private-key block', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
];

function textFiles(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(path, entry.name);
    if (entry.isDirectory()) return textFiles(fullPath);
    if (!entry.isFile() || !textExtensions.has(entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase())) return [];
    return [fullPath];
  });
}

test('implementation, fixtures, and operations docs contain no high-confidence credential literals', () => {
  const files = [
    ...['src', 'dist', 'test', 'docs', 'ops'].flatMap((directory) => textFiles(join(root, directory))),
    ...['.env.example', 'README.md'].map((name) => join(root, name)),
  ];
  for (const path of files) {
    const contents = readFileSync(path, 'utf8');
    for (const [label, pattern] of credentialPatterns) {
      assert.equal(pattern.test(contents), false, `${label} pattern found in ${relative(root, path)}`);
    }
  }
});

test('.env.example defines secret inputs only as empty placeholders', () => {
  const envExample = readFileSync(join(root, '.env.example'), 'utf8');
  for (const key of ['NEXORA_CONTROL_TOKEN', 'NEXORA_TELEGRAM_BOT_TOKEN']) {
    const line = envExample.split(/\r?\n/).find((item) => item.startsWith(key + '='));
    assert.ok(line, `${key} must be documented in .env.example`);
    assert.equal(line, key + '=', `${key} must remain an empty placeholder`);
  }
});
