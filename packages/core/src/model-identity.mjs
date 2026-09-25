const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const SNAPSHOT_SUFFIX = /^(?:\d{4}-\d{2}-\d{2}|\d{8})$/u;

export function normalizeProviderModel(value) {
  const text = String(value ?? '').trim();
  return MODEL_ID.test(text) ? text : null;
}

export function providerModelMatches(expected, observed) {
  const wanted = normalizeProviderModel(expected);
  const actual = normalizeProviderModel(observed);
  if (!wanted || !actual) return false;
  if (actual === wanted) return true;

  // A provider may resolve a stable alias to a dated immutable snapshot.
  // Do not accept arbitrary prefix matches: only dated snapshots.
  if (/(?:-\d{4}-\d{2}-\d{2}|-\d{8})$/u.test(wanted)) return false;
  if (!actual.startsWith(`${wanted}-`)) return false;
  return SNAPSHOT_SUFFIX.test(actual.slice(wanted.length + 1));
}

export function requireProviderModel({ provider, expected, observed }) {
  const wanted = normalizeProviderModel(expected);
  const actual = normalizeProviderModel(observed);
  if (!wanted) throw new Error(`${provider} expected model identity is invalid`);
  if (!actual) throw new Error(`${provider} response did not report a valid model identity`);
  if (!providerModelMatches(wanted, actual)) {
    throw new Error(`${provider} model identity mismatch: expected ${wanted}, received ${actual}`);
  }
  return actual;
}
