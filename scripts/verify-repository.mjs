import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';

const root = new URL('..', import.meta.url).pathname;

function skipped(entry) {
  return entry === '.git' || entry === 'node_modules' || entry.endsWith('.sqlite') || entry.includes('.sqlite-');
}

/** Every file path under `dir`; directories contribute their own listing. */
async function walk(dir) {
  const entries = (await readdir(dir)).filter((entry) => !skipped(entry));
  const listed = await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry);
    const info = await stat(path);
    return info.isDirectory() ? walk(path) : [path];
  }));
  return listed.flat();
}

const files = (await walk(root)).sort();
// The hasher is a streaming API and is fed file by file; the byte total is the
// fold's value, so nothing outside the fold is updated as files are read.
const { hash, bytes } = await files.reduce(async (pending, file) => {
  const state = await pending;
  const content = await readFile(file);
  state.hash.update(relative(root, file));
  state.hash.update('\0');
  state.hash.update(content);
  state.hash.update('\0');
  return { hash: state.hash, bytes: state.bytes + content.length };
}, Promise.resolve({ hash: createHash('sha256'), bytes: 0 }));
console.log(JSON.stringify({ files: files.length, bytes, content_sha256: hash.digest('hex') }, null, 2));
