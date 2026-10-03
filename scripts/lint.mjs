import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const allowed = new Set(['.mjs', '.json', '.md', '.yml', '.yaml', '.nix', '.example', '.env', '']);
const errors = [];

async function walk(dir) {
  for (const entry of await readdir(dir)) {
    if (entry === '.git' || entry === 'node_modules') continue;
    const path = join(dir, entry);
    const info = await stat(path);
    if (info.isDirectory()) {
      await walk(path);
      continue;
    }
    const rel = relative(root, path);
    const ext = extname(path);
    if (!allowed.has(ext) && !['Dockerfile', 'justfile', 'LICENSE'].includes(entry)) continue;
    const text = await readFile(path, 'utf8');
    if (!text.endsWith('\n')) errors.push(`${rel}: missing final newline`);
    if (text.includes('\r\n')) errors.push(`${rel}: CRLF line endings`);
    if (/gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|lin_api_[A-Za-z0-9]{20,}/.test(text)) {
      errors.push(`${rel}: credential-like token`);
    }
    if (ext === '.mjs') {
      const { spawnSync } = await import('node:child_process');
      const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
      if (result.status !== 0) errors.push(`${rel}: ${result.stderr.trim()}`);
    }
  }
}

await walk(root);
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log('lint: ok');
