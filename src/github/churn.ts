import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { CommitChurn } from '../types.ts';
import { classifyPath, SKIPPED } from './classify.ts';
import { GitHubClient, GitHubError, RateLimitExhausted, pool } from './client.ts';

/** Bump when classification changes in a way that requires refetching. */
const CACHE_VERSION = 1;

export interface ChurnTarget {
  oid: string;
  repo: string;
  add: number;
  del: number;
  merge: boolean;
}

interface CommitFile {
  filename: string;
  additions: number;
  deletions: number;
}

export interface ChurnCache {
  version: number;
  /** Keyed by opaque commit hash. Holds no repository or file names. */
  commits: Record<string, CommitChurn>;
}

export function loadChurnCache(path: string): ChurnCache {
  if (existsSync(path)) {
    const cache = JSON.parse(readFileSync(path, 'utf8')) as ChurnCache;
    if (cache.version === CACHE_VERSION) return cache;
  }
  return { version: CACHE_VERSION, commits: {} };
}

export function saveChurnCache(path: string, cache: ChurnCache): void {
  writeFileSync(path, JSON.stringify(cache));
}

export function summarizeFiles(files: CommitFile[], maxFileLines: number): CommitChurn {
  const out: CommitChurn = {};
  for (const file of files) {
    const oversized = file.additions + file.deletions > maxFileLines;
    const language = oversized ? SKIPPED : classifyPath(file.filename);
    const totals = (out[language] ??= [0, 0]);
    totals[0] += file.additions;
    totals[1] += file.deletions;
  }
  return out;
}

export interface ChurnResult {
  done: number;
  pending: number;
  failed: number;
  stoppedByLimit: boolean;
}

export interface ChurnOptions {
  maxRequests: number;
  maxFileLines: number;
  concurrency: number;
  /** Stop while this much REST budget is left, so a publish can still succeed. */
  reserve?: number;
  onCheckpoint?: () => void;
  log?: (message: string) => void;
}

/**
 * Fetches per-file stats for commits not yet cached. GraphQL has no per-file
 * commit stats, so this is one REST call per commit. The cache makes it
 * resumable: a run that hits its budget just continues on the next run.
 */
export async function collectChurn(
  client: GitHubClient,
  targets: ChurnTarget[],
  cache: ChurnCache,
  options: ChurnOptions,
): Promise<ChurnResult> {
  const reserve = options.reserve ?? 200;
  const log = options.log ?? (() => {});

  const queue: ChurnTarget[] = [];
  for (const target of targets) {
    if (cache.commits[target.oid]) continue;
    // Merges would double-count their parents; empty commits have nothing to fetch.
    if (target.merge || target.add + target.del === 0) {
      cache.commits[target.oid] = {};
      continue;
    }
    queue.push(target);
  }

  let requests = 0;
  let failed = 0;
  let stoppedByLimit = false;
  const outOfBudget = () =>
    stoppedByLimit ||
    requests >= options.maxRequests ||
    (client.coreRemaining !== null && client.coreRemaining <= reserve);

  if (queue.length) log(`churn: ${queue.length} commits to fetch (budget ${options.maxRequests})`);

  await pool(
    queue,
    options.concurrency,
    async (target) => {
      requests++;
      try {
        const commit = await client.rest<{ files?: CommitFile[] }>(`/repos/${target.repo}/commits/${target.oid}`);
        cache.commits[target.oid] = summarizeFiles(commit.files ?? [], options.maxFileLines);
      } catch (error) {
        if (error instanceof RateLimitExhausted) {
          stoppedByLimit = true;
        } else if (error instanceof GitHubError || error instanceof TypeError) {
          failed++;
        } else {
          throw error;
        }
      }
      if (requests % 200 === 0) {
        options.onCheckpoint?.();
        log(`churn: ${requests}/${queue.length} (REST budget left: ${client.coreRemaining ?? '?'})`);
      }
    },
    outOfBudget,
  );
  options.onCheckpoint?.();

  const pending = targets.filter((target) => !cache.commits[target.oid]).length;
  return {
    done: targets.length - pending,
    pending,
    failed,
    stoppedByLimit: stoppedByLimit || pending - failed > 0,
  };
}
