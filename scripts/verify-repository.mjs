import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';

const root = new URL('..', import.meta.url).pathname;
const files = [];

async function walk(dir) {
  for (const entry of await readdir(dir)) {
    if (entry === '.git' || entry === 'node_modules' || entry.endsWith('.sqlite') || entry.includes('.sqlite-')) continue;
    const path = join(dir, entry);
    const info = await stat(path);
    if (info.isDirectory()) await walk(path);
    else files.push(path);
  }
}

await walk(root);
files.sort();
const hash = createHash('sha256');
let bytes = 0;
for (const file of files) {
  const content = await readFile(file);
  bytes += content.length;
  hash.update(relative(root, file));
  hash.update('\0');
  hash.update(content);
  hash.update('\0');
}
console.log(JSON.stringify({ files: files.length, bytes, content_sha256: hash.digest('hex') }, null, 2));
