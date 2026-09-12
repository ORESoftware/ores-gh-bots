import { redactText } from './redact.mjs';

function byteLength(value) {
  return Buffer.byteLength(String(value ?? ''), 'utf8');
}

/** Largest prefix length of `text` (in UTF-16 units) whose UTF-8 encoding fits in `maxBytes`. */
function fitPrefix(text, maxBytes, low, high) {
  if (low >= high) return low;
  const mid = Math.ceil((low + high) / 2);
  return byteLength(text.slice(0, mid)) <= maxBytes
    ? fitPrefix(text, maxBytes, mid, high)
    : fitPrefix(text, maxBytes, low, mid - 1);
}

function truncateUtf8(value, maxBytes) {
  const text = String(value ?? '');
  if (byteLength(text) <= maxBytes) return { text, truncated: false };
  const keep = fitPrefix(text, maxBytes, 0, text.length);
  return { text: `${text.slice(0, keep)}\n[TRUNCATED]`, truncated: true };
}

/** One pull-request file rendered for the prompt, before the aggregate byte budget is applied. */
function renderFile(file, maxFileBytes) {
  const header = [
    `path: ${redactText(file.filename)}`,
    `status: ${file.status}`,
    `additions: ${file.additions ?? 0}`,
    `deletions: ${file.deletions ?? 0}`,
    `changes: ${file.changes ?? 0}`,
  ].join('\n');
  const binary = typeof file.patch !== 'string';
  const patch = redactText(binary ? '[BINARY OR PATCH UNAVAILABLE]' : file.patch);
  return { binary, perFile: truncateUtf8(`${header}\npatch:\n${patch}`, maxFileBytes) };
}

const EMPTY_SELECTION = Object.freeze({
  selected: [],
  totalBytes: 0,
  truncatedFiles: 0,
  omittedFiles: 0,
  binaryFiles: 0,
  exhausted: false,
});

/**
 * Fold one file into the selection and return the new selection. The selection is
 * never mutated: every counter and the `selected` list are rebuilt per step, and
 * `exhausted` records that the aggregate budget was hit so later files are skipped
 * (they were already counted as omitted when the budget ran out).
 */
function selectFile(state, file, { maxFiles, maxFileBytes, maxDiffBytes }, receivedFiles) {
  if (state.exhausted) return state;
  if (state.selected.length >= maxFiles) return { ...state, omittedFiles: state.omittedFiles + 1 };

  const { binary, perFile } = renderFile(file, maxFileBytes);
  const measured = {
    ...state,
    binaryFiles: state.binaryFiles + (binary ? 1 : 0),
    truncatedFiles: state.truncatedFiles + (perFile.truncated ? 1 : 0),
  };
  const remaining = maxDiffBytes - measured.totalBytes;
  if (remaining <= 0) return { ...measured, omittedFiles: measured.omittedFiles + 1 };

  const aggregate = truncateUtf8(perFile.text, remaining);
  const selected = [
    ...measured.selected,
    {
      path: redactText(file.filename),
      previous_filename: file.previous_filename ? redactText(file.previous_filename) : null,
      status: file.status,
      additions: file.additions ?? 0,
      deletions: file.deletions ?? 0,
      changes: file.changes ?? 0,
      patch: aggregate.text,
      truncated: perFile.truncated || aggregate.truncated,
    },
  ];
  const included = { ...measured, selected, totalBytes: measured.totalBytes + byteLength(aggregate.text) };
  if (!aggregate.truncated) return included;
  return {
    ...included,
    truncatedFiles: included.truncatedFiles + (perFile.truncated ? 0 : 1),
    omittedFiles: included.omittedFiles + Math.max(0, receivedFiles - selected.length),
    exhausted: true,
  };
}

export function collectPullRequestFiles(files, { maxFiles, maxFileBytes, maxDiffBytes }) {
  const limits = { maxFiles, maxFileBytes, maxDiffBytes };
  const { selected, totalBytes, truncatedFiles, omittedFiles, binaryFiles } = files.reduce(
    (state, file) => selectFile(state, file, limits, files.length),
    EMPTY_SELECTION,
  );

  return {
    files: selected,
    collection: {
      received_files: files.length,
      included_files: selected.length,
      omitted_files: omittedFiles,
      truncated_files: truncatedFiles,
      binary_or_unavailable_files: binaryFiles,
      included_bytes: totalBytes,
      limits,
      complete: omittedFiles === 0 && truncatedFiles === 0 && binaryFiles === 0,
    },
  };
}
