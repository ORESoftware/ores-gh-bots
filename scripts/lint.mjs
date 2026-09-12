import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const allowed = new Set(['.mjs', '.json', '.md', '.yml', '.yaml', '.nix', '.example', '.env', '']);

function syntaxErrors(rel, path) {
  const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
  return result.status !== 0 ? [`${rel}: ${result.stderr.trim()}`] : [];
}

/** The lint findings for one file, in check order. */
async function lintFile(path, entry) {
  const rel = relative(root, path);
  const ext = extname(path);
  if (!allowed.has(ext) && !['Dockerfile', 'justfile', 'LICENSE'].includes(entry)) return [];
  const text = await readFile(path, 'utf8');
  return [
    ...(text.endsWith('\n') ? [] : [`${rel}: missing final newline`]),
    ...(text.includes('\r\n') ? [`${rel}: CRLF line endings`] : []),
    ...(/gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|lin_api_[A-Za-z0-9]{20,}/.test(text) ? [`${rel}: credential-like token`] : []),
    ...(ext === '.mjs' ? syntaxErrors(rel, path) : []),
  ];
}

/** Every lint finding under `dir`, in directory order; each entry contributes its own list. */
async function walk(dir) {
  const entries = (await readdir(dir)).filter((entry) => entry !== '.git' && entry !== 'node_modules');
  const findings = await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry);
    const info = await stat(path);
    return info.isDirectory() ? walk(path) : lintFile(path, entry);
  }));
  return findings.flat();
}

const errors = await walk(root);
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log('lint: ok');
