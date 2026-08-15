import { redactText } from './redact.mjs';

function byteLength(value) {
  return Buffer.byteLength(String(value ?? ''), 'utf8');
}

function truncateUtf8(value, maxBytes) {
  const text = String(value ?? '');
  if (byteLength(text) <= maxBytes) return { text, truncated: false };
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (byteLength(text.slice(0, mid)) <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return { text: `${text.slice(0, low)}\n[TRUNCATED]`, truncated: true };
}

export function collectPullRequestFiles(files, { maxFiles, maxFileBytes, maxDiffBytes }) {
  const selected = [];
  let totalBytes = 0;
  let truncatedFiles = 0;
  let omittedFiles = 0;
  let binaryFiles = 0;

  for (const file of files) {
    if (selected.length >= maxFiles) {
      omittedFiles += 1;
      continue;
    }
    const header = [
      `path: ${redactText(file.filename)}`,
      `status: ${file.status}`,
      `additions: ${file.additions ?? 0}`,
      `deletions: ${file.deletions ?? 0}`,
      `changes: ${file.changes ?? 0}`,
    ].join('\n');
    let patch = file.patch;
    if (typeof patch !== 'string') {
      patch = '[BINARY OR PATCH UNAVAILABLE]';
      binaryFiles += 1;
    }
    patch = redactText(patch);
    const perFile = truncateUtf8(`${header}\npatch:\n${patch}`, maxFileBytes);
    if (perFile.truncated) truncatedFiles += 1;
    const remaining = maxDiffBytes - totalBytes;
    if (remaining <= 0) {
      omittedFiles += 1;
      continue;
    }
    const aggregate = truncateUtf8(perFile.text, remaining);
    selected.push({
      path: redactText(file.filename),
      previous_filename: file.previous_filename ? redactText(file.previous_filename) : null,
      status: file.status,
      additions: file.additions ?? 0,
      deletions: file.deletions ?? 0,
      changes: file.changes ?? 0,
      patch: aggregate.text,
      truncated: perFile.truncated || aggregate.truncated,
    });
    totalBytes += byteLength(aggregate.text);
    if (aggregate.truncated) {
      truncatedFiles += perFile.truncated ? 0 : 1;
      omittedFiles += Math.max(0, files.length - selected.length);
      break;
    }
  }

  return {
    files: selected,
    collection: {
      received_files: files.length,
      included_files: selected.length,
      omitted_files: omittedFiles,
      truncated_files: truncatedFiles,
      binary_or_unavailable_files: binaryFiles,
      included_bytes: totalBytes,
      limits: { maxFiles, maxFileBytes, maxDiffBytes },
    },
  };
}
