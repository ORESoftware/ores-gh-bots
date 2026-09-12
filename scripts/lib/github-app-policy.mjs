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

/** `[message]` when `failed` holds, otherwise nothing: the building block every rule below is made of. */
function errorWhen(failed, message) {
  return failed ? [message] : [];
}

function positiveIntegerOrNull(value) {
  return value === null || (Number.isInteger(value) && value > 0);
}

/** Parse one dotenv line into `{ key, value }`, or `null` for blank and comment lines. */
function parseDotenvLine(rawLine, index) {
  const line = rawLine.trim();
  if (!line || line.startsWith('#')) return null;
  const equals = rawLine.indexOf('=');
  if (equals < 1) throw new Error(`Invalid dotenv entry on line ${index + 1}`);
  const key = rawLine.slice(0, equals).trim();
  if (!/^[A-Z][A-Z0-9_]*$/u.test(key)) throw new Error(`Invalid dotenv key ${key} on line ${index + 1}`);
  return { key, value: rawLine.slice(equals + 1) };
}

export function parseDotenv(text) {
  const entries = text.split(/\r?\n/u).map(parseDotenvLine).filter(Boolean);
  // Later entries win, as successive assignment did; every repeated key is reported in order.
  return entries.reduce(
    ({ values, duplicates }, { key, value }) => ({
      values: { ...values, [key]: value },
      duplicates: Object.hasOwn(values, key) ? [...duplicates, key] : duplicates,
    }),
    { values: {}, duplicates: [] },
  );
}

function installationEntryErrors(prefix, installation) {
  const shapeErrors = [
    ...errorWhen(typeof installation.account !== 'string' || !installation.account, `${prefix} account is required`),
    ...errorWhen(!positiveIntegerOrNull(installation.installationId), `${prefix} installationId must be null or a positive integer`),
    ...errorWhen(!['all', 'selected'].includes(installation.repositorySelection), `${prefix} repositorySelection must be all or selected`),
  ];
  if (!Array.isArray(installation.repositories)) return [...shapeErrors, `${prefix} repositories must be an array`];
  return [
    ...shapeErrors,
    ...errorWhen(
      installation.repositorySelection === 'all' && installation.repositories.length !== 0,
      `${prefix} all-repository installation must not enumerate repositories`,
    ),
    ...errorWhen(
      installation.repositorySelection === 'selected' && installation.repositories.length === 0,
      `${prefix} selected-repository installation must enumerate repositories`,
    ),
  ];
}

function centralRepositoryErrors(role, appPolicy, installations, centralRepository) {
  if (appPolicy.installationScope !== 'central-repository') return [];
  if (installations.length !== 1) return [`${role}: central-repository App must have exactly one installation entry`];
  const [installation] = installations;
  const expectedAccount = centralRepository.split('/')[0];
  return [
    ...errorWhen(installation.account !== expectedAccount, `${role}: central-repository App must be installed on ${expectedAccount}`),
    ...errorWhen(
      installation.repositorySelection !== 'selected' || !sameJson(installation.repositories, [centralRepository]),
      `${role}: central-repository App must be restricted to ${centralRepository}`,
    ),
  ];
}

function installationErrors(role, appPolicy, appInventory, centralRepository) {
  if (!appInventory || typeof appInventory !== 'object') return [`${role}: missing installation inventory`];
  const identityErrors = [
    ...errorWhen(
      appInventory.visibility !== appPolicy.visibility,
      `${role}: inventory visibility ${appInventory.visibility ?? '<missing>'} does not match ${appPolicy.visibility}`,
    ),
    ...errorWhen(!positiveIntegerOrNull(appInventory.appId), `${role}: appId must be null or a positive integer`),
    ...errorWhen(typeof appInventory.slug !== 'string' || !appInventory.slug, `${role}: slug is required`),
  ];
  if (!Array.isArray(appInventory.installations) || appInventory.installations.length === 0) {
    return [...identityErrors, `${role}: at least one installation entry is required`];
  }
  return [
    ...identityErrors,
    ...appInventory.installations.flatMap((installation, index) => installationEntryErrors(`${role}: installation ${index + 1}`, installation)),
    ...centralRepositoryErrors(role, appPolicy, appInventory.installations, centralRepository),
  ];
}

function httpsUrlErrors(value, label) {
  try {
    return errorWhen(new URL(value ?? '').protocol !== 'https:', `orchestrator: ${label} URL must use HTTPS`);
  } catch {
    return [`orchestrator: ${label} URL must be valid`];
  }
}

function webhookErrors(role, manifest) {
  if (role === 'orchestrator') {
    return [
      ...errorWhen(manifest.hook_attributes?.active !== true, 'orchestrator: webhook must be active'),
      ...httpsUrlErrors(manifest.hook_attributes?.url, 'webhook'),
      ...httpsUrlErrors(manifest.redirect_url, 'redirect'),
    ];
  }
  return errorWhen(Boolean(manifest.hook_attributes || manifest.redirect_url), `${role}: non-webhook App must not configure hook or redirect URLs`);
}

function manifestErrors(role, expected, manifest) {
  const expectedPublic = expected.visibility === 'public-unlisted';
  return [
    ...errorWhen(manifest.public !== expectedPublic, `${role}: public must be ${expectedPublic}`),
    ...errorWhen(
      !sameJson(manifest.default_permissions ?? {}, expected.permissions ?? {}),
      `${role}: permission drift; expected ${JSON.stringify(expected.permissions ?? {})}, got ${JSON.stringify(manifest.default_permissions ?? {})}`,
    ),
    ...errorWhen(
      !sameJson(sortedStrings(manifest.default_events ?? []), sortedStrings(expected.events ?? [])),
      `${role}: event drift; expected ${JSON.stringify(sortedStrings(expected.events ?? []))}, got ${JSON.stringify(sortedStrings(manifest.default_events ?? []))}`,
    ),
    ...webhookErrors(role, manifest),
  ];
}

/** Errors for one role, plus the secret keys that role expects (none when its manifest is missing). */
function roleErrors({ role, policy, manifests, inventory, dotenv }) {
  const expected = policy.apps[role];
  const manifest = manifests[role];
  if (!manifest) return { errors: [`${role}: manifest is missing`], secretKeys: [] };
  const secretKeys = expected.secretEnv ?? [];
  return {
    secretKeys,
    errors: [
      ...manifestErrors(role, expected, manifest),
      ...secretKeys.flatMap((key) => errorWhen(!Object.hasOwn(dotenv.values, key), `env template: missing ${key}`)),
      ...installationErrors(role, expected, inventory?.apps?.[role], policy.centralRepository),
    ],
  };
}

function policyShapeErrors(policy, roles, manifestNames, manifestFiles) {
  return [
    ...errorWhen(policy?.version !== 1, 'policy: version must be 1'),
    ...errorWhen(!/^[^/]+\/[^/]+$/u.test(policy?.centralRepository ?? ''), 'policy: centralRepository must be owner/repo'),
    ...errorWhen(roles.length === 0, 'policy: at least one App role is required'),
    ...errorWhen(new Set(manifestNames).size !== manifestNames.length, 'policy: every role must use a unique manifest'),
    ...(manifestFiles.length > 0
      ? [
        ...manifestFiles.filter((name) => !manifestNames.includes(name)).map((name) => `manifest: ${name} is not covered by policy.json`),
        ...manifestNames.filter((name) => !manifestFiles.includes(name)).map((name) => `manifest: ${name} is listed in policy.json but missing`),
      ]
      : []),
  ];
}

/** The parsed template plus the errors parsing produced; an unparseable template counts as empty. */
function parseEnvTemplate(envTemplate) {
  try {
    const dotenv = parseDotenv(envTemplate ?? '');
    return { dotenv, errors: dotenv.duplicates.map((duplicate) => `env template: duplicate key ${duplicate}`) };
  } catch (error) {
    return { dotenv: { values: {}, duplicates: [] }, errors: [`env template: ${error.message}`] };
  }
}

function inventoryErrors(inventory, policy, roles) {
  const inventoryRoles = Object.keys(inventory?.apps ?? {});
  return [
    ...inventoryRoles.filter((role) => !roles.includes(role)).map((role) => `inventory: unknown App role ${role}`),
    ...roles.filter((role) => !inventoryRoles.includes(role)).map((role) => `inventory: missing App role ${role}`),
    ...errorWhen(inventory?.version !== 1, 'inventory: version must be 1'),
    ...errorWhen(inventory?.centralRepository !== policy?.centralRepository, 'inventory: centralRepository must match policy.json'),
  ];
}

const PROVIDER_SECRETS = Object.freeze(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY']);

function secretInventoryErrors(secretInventory, roleSecretKeys, dotenv) {
  const expectedSecretKeys = new Set([...roleSecretKeys, ...PROVIDER_SECRETS]);
  const documentedSecretKeys = new Set(secretInventory?.requiredKeys ?? []);
  return [
    ...[...expectedSecretKeys]
      .filter((key) => !documentedSecretKeys.has(key))
      .map((key) => `secret inventory: missing required key ${key}`),
    ...[...documentedSecretKeys].flatMap((key) => [
      ...errorWhen(!expectedSecretKeys.has(key), `secret inventory: undocumented extra key ${key}`),
      ...errorWhen(!Object.hasOwn(dotenv.values, key), `env template: missing required secret ${key}`),
    ]),
    ...errorWhen(secretInventory?.version !== 1, 'secret inventory: version must be 1'),
    ...errorWhen(secretInventory?.encryptedSource !== 'env/enc/review-bots.env', 'secret inventory: unexpected encrypted source'),
    ...errorWhen(secretInventory?.plaintextDestination !== 'env/dec/review-bots.env', 'secret inventory: unexpected plaintext destination'),
    ...errorWhen(secretInventory?.deployment?.provider !== 'kubernetes', 'secret inventory: deployment provider must be kubernetes'),
    ...errorWhen(
      !secretInventory?.deployment?.namespace || !secretInventory?.deployment?.secretName,
      'secret inventory: Kubernetes namespace and secretName are required',
    ),
    ...errorWhen(
      secretInventory?.rotation?.preserveAppIdentity !== true
        || secretInventory?.rotation?.preserveQueueStorage !== true
        || secretInventory?.rotation?.privateKeyOverlapRequired !== true,
      'secret inventory: rotation invariants are incomplete',
    ),
  ];
}

const CREDENTIAL_PATTERN = /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|lin_api_[A-Za-z0-9]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/u;

function credentialErrors(dotenv) {
  return Object.entries(dotenv.values)
    .filter(([, value]) => CREDENTIAL_PATTERN.test(value))
    .map(([key]) => `env template: ${key} contains credential-like material`);
}

/**
 * Validate the policy documents and return every error, in the same order the
 * checks run. Each section is a pure function from documents to an error list;
 * the sections are concatenated here rather than pushing into a shared array.
 */
export function validatePolicyDocuments({
  policy,
  manifests,
  manifestFiles = [],
  inventory,
  secretInventory,
  envTemplate,
}) {
  const roles = roleNames(policy);
  const manifestNames = roles.map((role) => policy.apps[role]?.manifest).filter(Boolean);
  const env = parseEnvTemplate(envTemplate);
  const perRole = roles.map((role) => roleErrors({ role, policy, manifests, inventory, dotenv: env.dotenv }));
  return [
    ...policyShapeErrors(policy, roles, manifestNames, manifestFiles),
    ...env.errors,
    ...perRole.flatMap((result) => result.errors),
    ...inventoryErrors(inventory, policy, roles),
    ...secretInventoryErrors(secretInventory, perRole.flatMap((result) => result.secretKeys), env.dotenv),
    ...credentialErrors(env.dotenv),
  ];
}

export async function loadPolicyDocuments(root) {
  const appDirectory = join(root, 'github-apps');
  const policy = JSON.parse(await readFile(join(appDirectory, 'policy.json'), 'utf8'));
  const manifestFiles = (await readdir(appDirectory)).filter((name) => name.endsWith('.manifest.json')).sort();
  const manifests = Object.fromEntries(await Promise.all(
    Object.entries(policy.apps ?? {}).map(async ([role, entry]) => [role, JSON.parse(await readFile(join(appDirectory, entry.manifest), 'utf8'))]),
  ));
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
