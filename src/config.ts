import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Config {
  /** IANA zone used to bucket activity. GitHub only returns UTC timestamps. */
  timezone: string;
  /** Only public gists can be pinned to a profile. */
  public: boolean;
  /** Local state: caches, ledger, snapshot. Never published as-is. */
  home: string;
  outDir: string;
  excludeLanguages: string[];
  /** Logins to name on the co-author card even for commits in private repos. */
  namedCoauthors: string[];
  /** Logins of your own AI agent accounts: named, and counted as AI rather than people. */
  agentCoauthors: string[];
  churn: {
    maxRequestsPerRun: number;
    maxFileLines: number;
    /** A commit changing more lines than this is a bulk import, not authored work. */
    maxCommitLines: number;
    concurrency: number;
  };
}

type ConfigFile = Partial<Omit<Config, 'churn'>> & { churn?: Partial<Config['churn']> };

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function systemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function parseConfig(text: string, source: string): ConfigFile {
  try {
    return JSON.parse(text) as ConfigFile;
  } catch (error) {
    throw new Error(`Could not parse config from ${source}: ${(error as Error).message}`);
  }
}

/**
 * The first match wins, so personal settings can stay out of the repository:
 * OMG_CONFIG_JSON (for Actions), OMG_CONFIG, <home>/config.json, then the repo's defaults.
 */
function readConfig(env: NodeJS.ProcessEnv, home: string): ConfigFile {
  if (env.OMG_CONFIG_JSON) return parseConfig(env.OMG_CONFIG_JSON, 'OMG_CONFIG_JSON');
  if (env.OMG_CONFIG) {
    if (!existsSync(env.OMG_CONFIG)) throw new Error(`OMG_CONFIG points to a missing file: ${env.OMG_CONFIG}`);
    return parseConfig(readFileSync(env.OMG_CONFIG, 'utf8'), env.OMG_CONFIG);
  }
  for (const path of [join(home, 'config.json'), join(ROOT, 'oh-my-gist.config.json')]) {
    if (existsSync(path)) return parseConfig(readFileSync(path, 'utf8'), path);
  }
  return {};
}

/** Uses `||` for environment values: Actions passes an unset variable as an empty string. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const home = resolve(env.OMG_HOME || join(homedir(), '.oh-my-gist'));
  mkdirSync(home, { recursive: true });
  const file = readConfig(env, home);

  const requested = env.OMG_TIMEZONE || file.timezone || 'auto';
  if (requested === 'auto' && env.CI) {
    console.error('Warning: timezone is "auto" on a CI runner, which is usually UTC. Set OMG_TIMEZONE.');
  }
  const timezone = requested === 'auto' ? systemTimezone() : requested;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw new Error(`Invalid timezone "${timezone}" in config. Use an IANA name like "Asia/Seoul".`);
  }

  return {
    timezone,
    public: file.public ?? true,
    home,
    outDir: resolve(env.OMG_OUT || join(ROOT, 'out')),
    excludeLanguages: file.excludeLanguages ?? [],
    namedCoauthors: file.namedCoauthors ?? [],
    agentCoauthors: file.agentCoauthors ?? [],
    churn: {
      maxRequestsPerRun: file.churn?.maxRequestsPerRun ?? 4000,
      maxFileLines: file.churn?.maxFileLines ?? 5000,
      maxCommitLines: file.churn?.maxCommitLines ?? 20000,
      concurrency: file.churn?.concurrency ?? 8,
    },
  };
}
