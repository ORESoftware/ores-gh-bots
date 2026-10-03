import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

function sortedObject(value) {
  if (Array.isArray(value)) return value.map(sortedObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedObject(value[key])]));
}

function sameJson(left, right) {
  return JSON.stringify(sortedObject(left)) === JSON.stringify(sortedObject(right));
}

function sortedStrings(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function roleNames(policy) {
  return Object.keys(policy?.apps ?? {});
}

export function parseDotenv(text) {
  const values = {};
  const duplicates = [];
  for (const [index, rawLine] of text.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const equals = rawLine.indexOf('=');
    if (equals < 1) throw new Error(`Invalid dotenv entry on line ${index + 1}`);
    const key = rawLine.slice(0, equals).trim();
    const value = rawLine.slice(equals + 1);
    if (!/^[A-Z][A-Z0-9_]*$/u.test(key)) throw new Error(`Invalid dotenv key ${key} on line ${index + 1}`);
    if (Object.hasOwn(values, key)) duplicates.push(key);
    values[key] = value;
  }
  return { values, duplicates };
}

function validateInstallation(role, appPolicy, appInventory, centralRepository, errors) {
  if (!appInventory || typeof appInventory !== 'object') {
    errors.push(`${role}: missing installation inventory`);
    return;
  }
  if (appInventory.visibility !== appPolicy.visibility) {
    errors.push(`${role}: inventory visibility ${appInventory.visibility ?? '<missing>'} does not match ${appPolicy.visibility}`);
  }
  if (!(appInventory.appId === null || (Number.isInteger(appInventory.appId) && appInventory.appId > 0))) {
    errors.push(`${role}: appId must be null or a positive integer`);
  }
  if (typeof appInventory.slug !== 'string' || !appInventory.slug) errors.push(`${role}: slug is required`);
  if (!Array.isArray(appInventory.installations) || appInventory.installations.length === 0) {
    errors.push(`${role}: at least one installation entry is required`);
    return;
  }

  for (const [index, installation] of appInventory.installations.entries()) {
    const prefix = `${role}: installation ${index + 1}`;
    if (typeof installation.account !== 'string' || !installation.account) errors.push(`${prefix} account is required`);
    if (!(installation.installationId === null || (Number.isInteger(installation.installationId) && installation.installationId > 0))) {
      errors.push(`${prefix} installationId must be null or a positive integer`);
    }
    if (!['all', 'selected'].includes(installation.repositorySelection)) {
      errors.push(`${prefix} repositorySelection must be all or selected`);
    }
    if (!Array.isArray(installation.repositories)) {
      errors.push(`${prefix} repositories must be an array`);
      continue;
    }
    if (installation.repositorySelection === 'all' && installation.repositories.length !== 0) {
      errors.push(`${prefix} all-repository installation must not enumerate repositories`);
    }
    if (installation.repositorySelection === 'selected' && installation.repositories.length === 0) {
      errors.push(`${prefix} selected-repository installation must enumerate repositories`);
    }
  }

  if (appPolicy.installationScope === 'central-repository') {
    if (appInventory.installations.length !== 1) {
      errors.push(`${role}: central-repository App must have exactly one installation entry`);
      return;
    }
    const installation = appInventory.installations[0];
    const expectedAccount = centralRepository.split('/')[0];
    if (installation.account !== expectedAccount) {
      errors.push(`${role}: central-repository App must be installed on ${expectedAccount}`);
    }
    if (installation.repositorySelection !== 'selected' || !sameJson(installation.repositories, [centralRepository])) {
      errors.push(`${role}: central-repository App must be restricted to ${centralRepository}`);
    }
  }
}

export function validatePolicyDocuments({
  policy,
  manifests,
  manifestFiles = [],
  inventory,
  secretInventory,
  envTemplate,
}) {
  const errors = [];
  if (policy?.version !== 1) errors.push('policy: version must be 1');
  if (!/^[^/]+\/[^/]+$/u.test(policy?.centralRepository ?? '')) errors.push('policy: centralRepository must be owner/repo');

  const roles = roleNames(policy);
  if (roles.length === 0) errors.push('policy: at least one App role is required');
  const manifestNames = roles.map((role) => policy.apps[role]?.manifest).filter(Boolean);
  if (new Set(manifestNames).size !== manifestNames.length) errors.push('policy: every role must use a unique manifest');

  if (manifestFiles.length > 0) {
    const unexpected = manifestFiles.filter((name) => !manifestNames.includes(name));
    const missing = manifestNames.filter((name) => !manifestFiles.includes(name));
    for (const name of unexpected) errors.push(`manifest: ${name} is not covered by policy.json`);
    for (const name of missing) errors.push(`manifest: ${name} is listed in policy.json but missing`);
  }

  let dotenv;
  try {
    dotenv = parseDotenv(envTemplate ?? '');
  } catch (error) {
    errors.push(`env template: ${error.message}`);
    dotenv = { values: {}, duplicates: [] };
  }
  for (const duplicate of dotenv.duplicates) errors.push(`env template: duplicate key ${duplicate}`);

  const expectedSecretKeys = new Set();
  for (const role of roles) {
    const expected = policy.apps[role];
    const manifest = manifests[role];
    if (!manifest) {
      errors.push(`${role}: manifest is missing`);
      continue;
    }
    const expectedPublic = expected.visibility === 'public-unlisted';
    if (manifest.public !== expectedPublic) {
      errors.push(`${role}: public must be ${expectedPublic}`);
    }
    if (!sameJson(manifest.default_permissions ?? {}, expected.permissions ?? {})) {
      errors.push(`${role}: permission drift; expected ${JSON.stringify(expected.permissions ?? {})}, got ${JSON.stringify(manifest.default_permissions ?? {})}`);
    }
    if (!sameJson(sortedStrings(manifest.default_events ?? []), sortedStrings(expected.events ?? []))) {
      errors.push(`${role}: event drift; expected ${JSON.stringify(sortedStrings(expected.events ?? []))}, got ${JSON.stringify(sortedStrings(manifest.default_events ?? []))}`);
    }
    if (role === 'orchestrator') {
      if (manifest.hook_attributes?.active !== true) errors.push('orchestrator: webhook must be active');
      try {
        const hookUrl = new URL(manifest.hook_attributes?.url ?? '');
        if (hookUrl.protocol !== 'https:') errors.push('orchestrator: webhook URL must use HTTPS');
      } catch {
        errors.push('orchestrator: webhook URL must be valid');
      }
      try {
        const redirectUrl = new URL(manifest.redirect_url ?? '');
        if (redirectUrl.protocol !== 'https:') errors.push('orchestrator: redirect URL must use HTTPS');
      } catch {
        errors.push('orchestrator: redirect URL must be valid');
      }
    } else if (manifest.hook_attributes || manifest.redirect_url) {
      errors.push(`${role}: non-webhook App must not configure hook or redirect URLs`);
    }

    for (const key of expected.secretEnv ?? []) {
      expectedSecretKeys.add(key);
      if (!Object.hasOwn(dotenv.values, key)) errors.push(`env template: missing ${key}`);
    }

    validateInstallation(role, expected, inventory?.apps?.[role], policy.centralRepository, errors);
  }

  const inventoryRoles = Object.keys(inventory?.apps ?? {});
  for (const role of inventoryRoles.filter((role) => !roles.includes(role))) errors.push(`inventory: unknown App role ${role}`);
  for (const role of roles.filter((role) => !inventoryRoles.includes(role))) errors.push(`inventory: missing App role ${role}`);
  if (inventory?.version !== 1) errors.push('inventory: version must be 1');
  if (inventory?.centralRepository !== policy?.centralRepository) {
    errors.push('inventory: centralRepository must match policy.json');
  }

  const providerSecrets = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'];
  for (const key of providerSecrets) expectedSecretKeys.add(key);
  const documentedSecretKeys = new Set(secretInventory?.requiredKeys ?? []);
  for (const key of expectedSecretKeys) {
    if (!documentedSecretKeys.has(key)) errors.push(`secret inventory: missing required key ${key}`);
  }
  for (const key of documentedSecretKeys) {
    if (!expectedSecretKeys.has(key)) errors.push(`secret inventory: undocumented extra key ${key}`);
    if (!Object.hasOwn(dotenv.values, key)) errors.push(`env template: missing required secret ${key}`);
  }
  if (secretInventory?.version !== 1) errors.push('secret inventory: version must be 1');
  if (secretInventory?.encryptedSource !== 'env/enc/review-bots.env') errors.push('secret inventory: unexpected encrypted source');
  if (secretInventory?.plaintextDestination !== 'env/dec/review-bots.env') errors.push('secret inventory: unexpected plaintext destination');
  if (secretInventory?.deployment?.provider !== 'kubernetes') errors.push('secret inventory: deployment provider must be kubernetes');
  if (!secretInventory?.deployment?.namespace || !secretInventory?.deployment?.secretName) {
    errors.push('secret inventory: Kubernetes namespace and secretName are required');
  }
  if (secretInventory?.rotation?.preserveAppIdentity !== true
    || secretInventory?.rotation?.preserveQueueStorage !== true
    || secretInventory?.rotation?.privateKeyOverlapRequired !== true) {
    errors.push('secret inventory: rotation invariants are incomplete');
  }

  const credentialPattern = /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|lin_api_[A-Za-z0-9]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/u;
  for (const [key, value] of Object.entries(dotenv.values)) {
    if (credentialPattern.test(value)) errors.push(`env template: ${key} contains credential-like material`);
  }

  return errors;
}

export async function loadPolicyDocuments(root) {
  const appDirectory = join(root, 'github-apps');
  const policy = JSON.parse(await readFile(join(appDirectory, 'policy.json'), 'utf8'));
  const manifestFiles = (await readdir(appDirectory)).filter((name) => name.endsWith('.manifest.json')).sort();
  const manifests = {};
  for (const [role, entry] of Object.entries(policy.apps ?? {})) {
    manifests[role] = JSON.parse(await readFile(join(appDirectory, entry.manifest), 'utf8'));
  }
  const inventory = JSON.parse(await readFile(join(root, 'config/installations.example.json'), 'utf8'));
  const secretInventory = JSON.parse(await readFile(join(root, 'config/secrets.example.json'), 'utf8'));
  const envTemplate = await readFile(join(root, '.env.example'), 'utf8');
  return { policy, manifests, manifestFiles, inventory, secretInventory, envTemplate };
}

export async function assertPolicyDocuments(root) {
  const documents = await loadPolicyDocuments(root);
  const errors = validatePolicyDocuments(documents);
  if (errors.length > 0) {
    throw new Error(`GitHub App policy validation failed:\n- ${errors.join('\n- ')}`);
  }
  return {
    roles: roleNames(documents.policy).length,
    manifests: documents.manifestFiles.length,
    requiredSecrets: documents.secretInventory.requiredKeys.length,
  };
}
