import { fileURLToPath } from 'node:url';
import { auditConfig, coerce, parseStructured } from '@oresoftware/f2e';

export const CLI_FLAGS_PATH = fileURLToPath(new URL('../../../.cli-flags.toml', import.meta.url));

let audited = false;

const PARSER_METADATA_KEYS = new Set([
  'ORES_GH_BOTS_COMMAND',
  'ORES_GH_BOTS_POSITIONALS',
  'ORES_GH_BOTS_UNKNOWN_OPTIONS',
  'ORES_GH_BOTS_PARSE_ERRORS',
]);

function optionTokenCount(argv) {
  let count = 0;
  for (const item of argv.slice(1)) {
    if (item === '--') break;
    if (item === '--help') continue;
    if (item.length > 1 && item.startsWith('-')) count += 1;
  }
  return count;
}

function auditContract(configPath) {
  if (audited && configPath === CLI_FLAGS_PATH) return;
  const report = auditConfig({ configPath });
  if (!report.ok) {
    throw new Error(`flags-2-env contract audit failed with ${report.errorCount} error(s)`);
  }
  if (configPath === CLI_FLAGS_PATH) audited = true;
}

/**
 * Resolve argv and .env before any executable performs effects. Schema defaults
 * are lowest precedence, followed by ordinary .env, process env, .env entries
 * explicitly declared to override process env, and finally argv overrides.
 */
export function resolveCli(argv = process.argv, { env = process.env, configPath = CLI_FLAGS_PATH } = {}) {
  auditContract(configPath);
  const parsed = parseStructured(argv, { configPath });
  if (parsed.isHelpMenu) {
    return Object.freeze({
      command: parsed.command,
      positionals: Object.freeze([...parsed.extras]),
      env: Object.freeze({ ...env }),
      values: Object.freeze({}),
      help: true,
      printHelp: (target = process.stdout) => parsed.printTable(target),
    });
  }
  if (parsed.unknownOptions.length > 0 || parsed.errors.length > 0) {
    throw new Error(
      `flags-2-env rejected CLI input (unknown=${parsed.unknownOptions.length}, invalid=${parsed.errors.length})`,
    );
  }
  const providedFlagCount = Object.keys(parsed.providedFlags)
    .filter((key) => !PARSER_METADATA_KEYS.has(key))
    .length;
  if (optionTokenCount(argv) > providedFlagCount) {
    throw new Error('flags-2-env rejected CLI input (duplicate option)');
  }
  const resolvedEnv = Object.freeze({
    ...parsed.flags,
    ...parsed.dotenv,
    ...env,
    ...parsed.dotenvOverrides,
    ...parsed.providedFlags,
  });
  const values = Object.freeze(coerce(resolvedEnv, { configPath }));
  return Object.freeze({
    command: parsed.command,
    positionals: Object.freeze([...parsed.extras]),
    env: resolvedEnv,
    values,
    help: false,
    printHelp: (target = process.stdout) => parsed.printTable(target),
  });
}
