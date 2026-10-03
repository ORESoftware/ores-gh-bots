const PATTERNS = [
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
  ['linear-token', /\blin_api_[A-Za-z0-9]{20,}\b/g],
  ['openai-key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g],
  ['sendgrid-key', /\bSG\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}\b/g],
  ['cloudflare-token', /\bcfat_[A-Za-z0-9_-]{20,}\b/g],
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['authorization', /\b(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/gi],
  ['secret-assignment', /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY)[A-Z0-9_]*\s*[:=]\s*)["']?[^\s"'`,;]{8,}/gi],
  ['url-credential', /\bhttps?:\/\/[^\s/@:]+:[^\s/@]+@/gi],
];

export function redactText(value) {
  let text = String(value ?? '');
  for (const [name, pattern] of PATTERNS) {
    text = text.replace(pattern, (match, prefix) => {
      if (name === 'authorization' || name === 'secret-assignment') {
        return `${prefix ?? ''}[REDACTED:${name}]`;
      }
      if (name === 'url-credential') {
        return match.replace(/\/\/.*@/, '//[REDACTED:url-credential]@');
      }
      return `[REDACTED:${name}]`;
    });
  }
  return text;
}

export function redactObject(value) {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactObject);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactObject(item)]));
  }
  return value;
}

export function containsCredentialLikeText(value) {
  const text = String(value ?? '');
  return PATTERNS.some(([, pattern]) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}
