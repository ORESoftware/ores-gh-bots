import { createHash } from 'node:crypto';
import {
  HEX_160,
  HEX_256,
  REPOSITORY,
  SAFE_ID,
  SET_LIKE_ARRAY_KEYS,
} from './constants.mjs';

export class AdmissionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AdmissionError';
    this.code = code;
  }
}

export function fail(code, message) {
  throw new AdmissionError(code, message);
}

export function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function requireObject(value, code, label) {
  if (!isObject(value)) fail(code, `${label} must be an object`);
  return value;
}

export function requireArray(value, code, label) {
  if (!Array.isArray(value)) fail(code, `${label} must be an array`);
  return value;
}

export function requireExactKeys(value, required, allowed, code, label) {
  const object = requireObject(value, code, label);
  const keys = Object.keys(object);
  for (const key of required) {
    if (!Object.hasOwn(object, key)) fail(code, `${label} is missing ${key}`);
  }
  for (const key of keys) {
    if (!allowed.has(key)) fail(code, `${label} contains unsupported key ${key}`);
  }
  return object;
}

export function requireString(value, code, label, pattern = SAFE_ID) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    fail(code, `${label} is invalid`);
  }
  return value;
}

export function requireBoundedText(value, code, label, maximum = 4096) {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail(code, `${label} must be non-empty bounded text without control characters`);
  }
  return value;
}

export function requireBoolean(value, code, label) {
  if (typeof value !== 'boolean') fail(code, `${label} must be boolean`);
  return value;
}

export function requireNonNegativeInteger(value, code, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(code, `${label} must be a non-negative safe integer`);
  }
  return value;
}

export function requireHex160(value, code, label) {
  return requireString(value, code, label, HEX_160);
}

export function requireHex256(value, code, label) {
  return requireString(value, code, label, HEX_256);
}

export function requireNullableHex256(value, code, label) {
  if (value === null) return null;
  return requireHex256(value, code, label);
}

export function requireRepository(value, code, label) {
  return requireString(value, code, label, REPOSITORY);
}

export function requireSafePath(value, code, label) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1024) {
    fail(code, `${label} must be a bounded relative path`);
  }
  if (value.startsWith('/') || value.includes('\\') || value.includes('\0')) {
    fail(code, `${label} must be a normalized relative path`);
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    fail(code, `${label} contains an unsafe path segment`);
  }
  return value;
}

export function requireSource(value, label) {
  const source = requireExactKeys(
    value,
    ['file'],
    new Set(['file', 'pointer', 'line', 'column']),
    'invalid_source',
    label,
  );
  requireSafePath(source.file, 'invalid_source', `${label}.file`);
  if (source.pointer !== undefined) {
    requireBoundedText(source.pointer, 'invalid_source', `${label}.pointer`, 2048);
  }
  if (source.line !== undefined && (!Number.isSafeInteger(source.line) || source.line < 1)) {
    fail('invalid_source', `${label}.line is invalid`);
  }
  if (source.column !== undefined && (!Number.isSafeInteger(source.column) || source.column < 1)) {
    fail('invalid_source', `${label}.column is invalid`);
  }
}

export function canonicalizeTsjsvV1(value, parentKey = '') {
  if (Array.isArray(value)) {
    const values = value.map((item) => canonicalizeTsjsvV1(item, ''));
    if (SET_LIKE_ARRAY_KEYS.has(parentKey)) {
      const byEncoding = new Map();
      for (const item of values) byEncoding.set(JSON.stringify(item), item);
      return [...byEncoding.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, item]) => item);
    }
    return values;
  }
  if (!isObject(value)) return value;
  const result = Object.create(null);
  for (const key of Object.keys(value).sort()) {
    result[key] = canonicalizeTsjsvV1(value[key], key);
  }
  return result;
}

export function canonicalStringifyTsjsvV1(value) {
  return JSON.stringify(canonicalizeTsjsvV1(value));
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function digestCanonical(value) {
  return sha256(canonicalStringifyTsjsvV1(value));
}

export function canonicalStringifyTsjsvV1OrNull(value) {
  return canonicalStringifyTsjsvV1(value ?? null);
}

function scanJsonStructure(text, label, maximumDepth = 128) {
  let index = 0;

  const syntaxError = () => fail('artifact_json', `${label} is not valid JSON`);
  const skipWhitespace = () => {
    while (
      text[index] === ' ' ||
      text[index] === '\n' ||
      text[index] === '\r' ||
      text[index] === '\t'
    ) {
      index += 1;
    }
  };
  const parseString = () => {
    if (text[index] !== '"') syntaxError();
    const start = index;
    index += 1;
    while (index < text.length) {
      const character = text[index];
      if (character === '"') {
        index += 1;
        try {
          return JSON.parse(text.slice(start, index));
        } catch {
          return syntaxError();
        }
      }
      if (character === '\\') {
        index += 1;
        if (index >= text.length) syntaxError();
        const escape = text[index];
        if (escape === 'u') {
          const code = text.slice(index + 1, index + 5);
          if (!/^[a-fA-F0-9]{4}$/u.test(code)) syntaxError();
          index += 5;
          continue;
        }
        if (!'["\\/bfnrt]'.includes(escape)) syntaxError();
        index += 1;
        continue;
      }
      if (character.charCodeAt(0) < 0x20) syntaxError();
      index += 1;
    }
    return syntaxError();
  };
  const parseNumber = () => {
    const match = text.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u);
    if (!match) syntaxError();
    index += match[0].length;
  };
  const parseLiteral = (literal) => {
    if (!text.startsWith(literal, index)) syntaxError();
    index += literal.length;
  };
  const parseValue = (depth) => {
    skipWhitespace();
    const character = text[index];
    if (character === '{') return parseObject(depth + 1);
    if (character === '[') return parseArray(depth + 1);
    if (character === '"') return parseString();
    if (character === 't') return parseLiteral('true');
    if (character === 'f') return parseLiteral('false');
    if (character === 'n') return parseLiteral('null');
    return parseNumber();
  };
  const parseObject = (depth) => {
    if (depth > maximumDepth) {
      fail('artifact_depth', `${label} exceeds the maximum JSON nesting depth of ${maximumDepth}`);
    }
    index += 1;
    skipWhitespace();
    if (text[index] === '}') {
      index += 1;
      return;
    }
    const keys = new Set();
    while (index < text.length) {
      skipWhitespace();
      const key = parseString();
      if (keys.has(key)) {
        fail('artifact_duplicate_key', `${label} contains duplicate JSON key ${JSON.stringify(key)}`);
      }
      keys.add(key);
      skipWhitespace();
      if (text[index] !== ':') syntaxError();
      index += 1;
      parseValue(depth);
      skipWhitespace();
      if (text[index] === '}') {
        index += 1;
        return;
      }
      if (text[index] !== ',') syntaxError();
      index += 1;
    }
    return syntaxError();
  };
  const parseArray = (depth) => {
    if (depth > maximumDepth) {
      fail('artifact_depth', `${label} exceeds the maximum JSON nesting depth of ${maximumDepth}`);
    }
    index += 1;
    skipWhitespace();
    if (text[index] === ']') {
      index += 1;
      return;
    }
    while (index < text.length) {
      parseValue(depth);
      skipWhitespace();
      if (text[index] === ']') {
        index += 1;
        return;
      }
      if (text[index] !== ',') syntaxError();
      index += 1;
    }
    return syntaxError();
  };

  parseValue(0);
  skipWhitespace();
  if (index !== text.length) syntaxError();
}

export function parseArtifact(text, label, maxArtifactBytes) {
  if (typeof text !== 'string') fail('artifact_missing', `${label} text is required`);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes < 2 || bytes > maxArtifactBytes) {
    fail('artifact_size', `${label} must be between 2 and ${maxArtifactBytes} bytes`);
  }
  scanJsonStructure(text, label);
  try {
    return JSON.parse(text);
  } catch {
    return fail('artifact_json', `${label} is not valid JSON`);
  }
}

export function normalizeEvidenceFiles(files, label) {
  const values = requireArray(files, 'invalid_input_files', `${label}.files`);
  if (values.length === 0) fail('invalid_input_files', `${label}.files must not be empty`);
  const normalized = [];
  const seen = new Set();
  for (let index = 0; index < values.length; index += 1) {
    const item = requireObject(values[index], 'invalid_input_files', `${label}.files[${index}]`);
    const path = item.relativePath ?? item.path;
    requireSafePath(path, 'invalid_input_files', `${label}.files[${index}].path`);
    requireHex256(item.sha256, 'invalid_input_files', `${label}.files[${index}].sha256`);
    if (seen.has(path)) fail('duplicate_input_file', `${label}.files repeats ${path}`);
    seen.add(path);
    normalized.push({ path, sha256: item.sha256 });
  }
  return normalized.sort((left, right) => left.path.localeCompare(right.path));
}
