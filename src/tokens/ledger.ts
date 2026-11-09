import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { TokenLedger, TokenTotals, UsageTuple } from '../types.ts';
import { zoned } from '../util/time.ts';
import { mergeEvents, parseClaudeLog, parseCodexLog, type Tool, type UsageEvent } from './parsers.ts';
import { mergeTotals } from './totals.ts';

export const EMPTY_LEDGER: TokenLedger = { version: 1, days: {} };

interface LogFile {
  path: string;
  tool: Tool;
  mtimeMs: number;
  size: number;
}

/** [key, at, model, input, output, cacheRead, cacheWrite] */
type CachedEvent = [string, string, string, number, number, number, number];

interface FileCache {
  version: 1;
  /** Keyed by a hash of the path, because paths can name private projects. */
  files: Record<string, { mtimeMs: number; size: number; tool: Tool; events: CachedEvent[] }>;
}

export interface LogRoots {
  claude: string[];
  codex: string[];
}

export function defaultLogRoots(env: NodeJS.ProcessEnv = process.env): LogRoots {
  const home = homedir();
  const claudeBases = env.CLAUDE_CONFIG_DIR ? [env.CLAUDE_CONFIG_DIR] : [join(home, '.claude'), join(home, '.config', 'claude')];
  const codexBase = env.CODEX_HOME ?? join(home, '.codex');
  return {
    claude: claudeBases.map((base) => join(base, 'projects')),
    codex: [join(codexBase, 'sessions'), join(codexBase, 'archived_sessions')],
  };
}

async function findLogs(roots: string[], tool: Tool, matches: (name: string) => boolean): Promise<LogFile[]> {
  const out: LogFile[] = [];
  for (const root of roots) {
    let entries;
    try {
      entries = await readdir(root, { recursive: true, withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !matches(entry.name)) continue;
      const path = join(entry.parentPath, entry.name);
      try {
        const info = await stat(path);
        out.push({ path, tool, mtimeMs: info.mtimeMs, size: info.size });
      } catch {
        // Deleted between listing and stat.
      }
    }
  }
  return out;
}

export async function discoverLogs(roots: LogRoots): Promise<LogFile[]> {
  return [
    ...(await findLogs(roots.claude, 'claude', (name) => name.endsWith('.jsonl'))),
    ...(await findLogs(roots.codex, 'codex', (name) => name.endsWith('.jsonl') || name.endsWith('.jsonl.zst'))),
  ];
}

function loadFileCache(path: string): FileCache {
  if (existsSync(path)) {
    try {
      const cache = JSON.parse(readFileSync(path, 'utf8')) as FileCache;
      if (cache.version === 1) return cache;
    } catch {
      // A corrupt cache only costs a rescan.
    }
  }
  return { version: 1, files: {} };
}

export interface ScanResult {
  events: UsageEvent[];
  files: number;
  parsed: number;
  failed: number;
}

/** Parses only logs that changed since the last scan; the logs run to gigabytes. */
export async function scanLogs(roots: LogRoots, home: string, log: (message: string) => void = () => {}): Promise<ScanResult> {
  const cachePath = join(home, 'token-files.json');
  const cache = loadFileCache(cachePath);
  const logs = await discoverLogs(roots);
  const next: FileCache = { version: 1, files: {} };
  const stale: LogFile[] = [];
  let failed = 0;

  for (const file of logs) {
    const id = createHash('sha256').update(file.path).digest('hex').slice(0, 24);
    const cached = cache.files[id];
    if (cached && cached.mtimeMs === file.mtimeMs && cached.size === file.size) next.files[id] = cached;
    else stale.push(file);
  }
  if (stale.length) log(`tokens: parsing ${stale.length} of ${logs.length} log files`);

  let cursor = 0;
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      while (cursor < stale.length) {
        const file = stale[cursor++];
        const id = createHash('sha256').update(file.path).digest('hex').slice(0, 24);
        try {
          const events = file.tool === 'claude' ? await parseClaudeLog(file.path) : await parseCodexLog(file.path);
          next.files[id] = {
            mtimeMs: file.mtimeMs,
            size: file.size,
            tool: file.tool,
            events: events.map((event) => [
              createHash('sha256').update(event.key).digest('hex').slice(0, 20),
              event.at,
              event.model,
              event.input,
              event.output,
              event.cacheRead,
              event.cacheWrite,
            ]),
          };
        } catch {
          failed++;
        }
      }
    }),
  );
  writeFileSync(cachePath, JSON.stringify(next));

  const all: UsageEvent[] = [];
  for (const file of Object.values(next.files)) {
    for (const [key, at, model, input, output, cacheRead, cacheWrite] of file.events) {
      all.push({ key, at, model, input, output, cacheRead, cacheWrite, tool: file.tool });
    }
  }
  return { events: mergeEvents(all), files: logs.length, parsed: stale.length, failed };
}

export function ledgerFromEvents(events: UsageEvent[], timezone: string): TokenLedger {
  const days: TokenLedger['days'] = {};
  for (const event of events) {
    if (!event.at) continue;
    const date = zoned(event.at, timezone).date;
    const day = (days[date] ??= {});
    const row = (day[`${event.tool}/${event.model}`] ??= [0, 0, 0, 0, 0]);
    row[0] += event.input;
    row[1] += event.output;
    row[2] += event.cacheRead;
    row[3] += event.cacheWrite;
    row[4] += 1;
  }
  return { version: 1, days };
}

const size = (row: UsageTuple) => row[0] + row[1] + row[2] + row[3];

/**
 * Keeps the larger figure per day and model. Assistants delete old logs (Claude
 * Code after about 30 days), so a rescan can only under-report past days. Taking
 * the maximum keeps history intact while still picking up today's new usage.
 */
export function mergeLedgers(...ledgers: TokenLedger[]): TokenLedger {
  const days: TokenLedger['days'] = {};
  for (const ledger of ledgers) {
    for (const [date, rows] of Object.entries(ledger.days)) {
      const day = (days[date] ??= {});
      for (const [key, row] of Object.entries(rows)) {
        if (!day[key] || size(row) > size(day[key])) day[key] = row;
      }
    }
  }
  const totals = mergeTotals(...ledgers.map((ledger) => ledger.totals));
  return totals ? { version: 1, days, totals } : { version: 1, days };
}

export function loadLedger(path: string): TokenLedger {
  if (!existsSync(path)) return EMPTY_LEDGER;
  try {
    const ledger = JSON.parse(readFileSync(path, 'utf8')) as TokenLedger;
    return ledger.version === 1 && ledger.days ? ledger : EMPTY_LEDGER;
  } catch {
    return EMPTY_LEDGER;
  }
}

export function serializeLedger(ledger: TokenLedger): string {
  const sorted: TokenLedger['days'] = {};
  for (const date of Object.keys(ledger.days).sort()) sorted[date] = ledger.days[date];
  return JSON.stringify({ version: 1, days: sorted, ...(ledger.totals ? { totals: ledger.totals } : {}) }, null, 1) + '\n';
}

export async function collectTokens(
  roots: LogRoots,
  home: string,
  timezone: string,
  log: (message: string) => void = () => {},
  totals?: TokenTotals,
): Promise<{ ledger: TokenLedger; scan: ScanResult }> {
  const path = join(home, 'token-ledger.json');
  const scan = await scanLogs(roots, home, log);
  const ledger = mergeLedgers(loadLedger(path), { ...ledgerFromEvents(scan.events, timezone), totals });
  writeFileSync(path, serializeLedger(ledger));
  return { ledger, scan };
}
