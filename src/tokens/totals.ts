import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { TokenBreakdown, TokenTotals, ToolTotals } from '../types.ts';

/**
 * Lifetime figures reported by the tools themselves. Local logs get deleted and
 * only cover one machine, so summing them alone under-counts badly. These readers
 * return null on any problem: a missing figure must never break a run, and the
 * last known value stays in the ledger.
 */

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const tokenCount = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);

export function defaultClaudeDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = homedir();
  return env.CLAUDE_CONFIG_DIR ? [env.CLAUDE_CONFIG_DIR] : [join(home, '.claude'), join(home, '.config', 'claude')];
}

/**
 * Claude Code keeps running statistics in stats-cache.json, the source of its own
 * usage views. They outlive transcript cleanup, but the file format isn't a public
 * contract, so anything unexpected counts as unavailable.
 */
export function readClaudeStats(dirs: string[] = defaultClaudeDirs()): ToolTotals | null {
  for (const dir of dirs) {
    const path = join(dir, 'stats-cache.json');
    if (!existsSync(path)) continue;
    try {
      const stats = JSON.parse(readFileSync(path, 'utf8'));
      if (!stats?.modelUsage || typeof stats.modelUsage !== 'object') return null;

      const models: Record<string, TokenBreakdown> = {};
      let total = 0;
      for (const [model, usage] of Object.entries<any>(stats.modelUsage)) {
        const row: TokenBreakdown = [
          tokenCount(usage?.inputTokens),
          tokenCount(usage?.outputTokens),
          tokenCount(usage?.cacheReadInputTokens),
          tokenCount(usage?.cacheCreationInputTokens),
        ];
        const sum = row[0] + row[1] + row[2] + row[3];
        if (sum === 0) continue;
        models[model] = row;
        total += sum;
      }
      if (total === 0) return null;

      const daily: Record<string, number> = {};
      if (Array.isArray(stats.dailyModelTokens)) {
        for (const entry of stats.dailyModelTokens) {
          if (typeof entry?.date !== 'string' || !DATE.test(entry.date)) continue;
          const sum = Object.values<unknown>(entry.tokensByModel ?? {}).reduce<number>((all, value) => all + tokenCount(value), 0);
          if (sum > 0) daily[entry.date] = sum;
        }
      }
      const dates = Object.keys(daily).sort();
      const asOf = typeof stats.lastComputedDate === 'string' && DATE.test(stats.lastComputedDate) ? stats.lastComputedDate : (dates.at(-1) ?? null);
      return { scope: 'machine', total, asOf, models, daily };
    } catch {
      return null;
    }
  }
  return null;
}

export interface CodexAccountOptions {
  command?: string[];
  timeoutMs?: number;
}

/**
 * The figure behind Codex's `/usage`: the account's lifetime total, across every
 * device. It comes from the user's own CLI over its documented app-server protocol,
 * so this tool never touches Codex credentials. Accounts without usage analytics
 * report nothing and count as unavailable.
 */
export function readCodexAccount(options: CodexAccountOptions = {}): Promise<ToolTotals | null> {
  const [program, ...args] = options.command ?? ['codex', 'app-server'];
  return new Promise((resolve) => {
    const child = spawn(program, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    let settled = false;
    const finish = (result: ToolTotals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), options.timeoutMs ?? 30_000);
    const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);

    child.on('error', () => finish(null));
    child.on('close', () => finish(null));
    child.stdin.on('error', () => finish(null));

    createInterface({ input: child.stdout }).on('line', (line) => {
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id === 1) {
        if (message.error) return finish(null);
        send({ method: 'initialized' });
        send({ id: 2, method: 'account/usage/read' });
      } else if (message.id === 2) {
        finish(message.error ? null : parseAccountUsage(message.result));
      }
    });

    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'oh_my_gist', title: 'oh-my-gist', version: '0.1.0' } } });
  });
}

function parseAccountUsage(result: any): ToolTotals | null {
  const total = tokenCount(result?.summary?.lifetimeTokens);
  if (total === 0) return null;
  const daily: Record<string, number> = {};
  if (Array.isArray(result.dailyUsageBuckets)) {
    for (const bucket of result.dailyUsageBuckets) {
      const date = typeof bucket?.startDate === 'string' ? bucket.startDate.slice(0, 10) : '';
      const tokens = tokenCount(bucket?.tokens);
      if (DATE.test(date) && tokens > 0) daily[date] = (daily[date] ?? 0) + tokens;
    }
  }
  return { scope: 'account', total, asOf: Object.keys(daily).sort().at(-1) ?? null, daily };
}

/** Lifetime totals only grow, so the larger figure wins and known days are kept. */
export function mergeTotals(...sets: (TokenTotals | undefined)[]): TokenTotals | undefined {
  const merged: TokenTotals = {};
  for (const set of sets) {
    for (const [tool, next] of Object.entries(set ?? {})) {
      const current = merged[tool];
      const winner = !current || next.total >= current.total ? next : current;
      const daily: Record<string, number> = { ...current?.daily };
      for (const [date, value] of Object.entries(next.daily ?? {})) daily[date] = Math.max(daily[date] ?? 0, value);
      merged[tool] = { ...winner, daily };
    }
  }
  return Object.keys(merged).length ? merged : undefined;
}

export async function collectToolTotals(log: (message: string) => void = () => {}): Promise<TokenTotals> {
  const totals: TokenTotals = {};
  const claude = readClaudeStats();
  if (claude) totals.claude = claude;
  const codex = await readCodexAccount();
  if (codex) totals.codex = codex;
  if (!claude) log('tokens: Claude Code statistics unavailable; using logs or the last known total');
  if (!codex) log('tokens: Codex account usage unavailable; using logs or the last known total');
  return totals;
}
