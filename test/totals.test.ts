import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { computeMetrics } from '../src/metrics.ts';
import { buildCards, CARD_LINES, CARD_WIDTH, cardContent } from '../src/render/cards.ts';
import { renderDashboard } from '../src/render/svg.ts';
import { collectTokens, mergeLedgers, serializeLedger } from '../src/tokens/ledger.ts';
import { mergeTotals, readClaudeStats, readCodexAccount } from '../src/tokens/totals.ts';
import type { PriceTable, TokenLedger, ToolTotals } from '../src/types.ts';
import { displayWidth } from '../src/util/format.ts';

const NOW = new Date('2026-11-09T05:00:00Z');
const TZ = 'Asia/Seoul';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'omg-totals-'));
}

function statsDir(content: unknown): string {
  const dir = tempDir();
  writeFileSync(join(dir, 'stats-cache.json'), typeof content === 'string' ? content : JSON.stringify(content));
  return dir;
}

const SAMPLE_STATS = {
  version: 5,
  lastComputedDate: '2026-11-08',
  dailyModelTokens: [
    { date: '2026-10-01', tokensByModel: { 'claude-opus-5-5': 100, 'claude-fable-5': 50 } },
    { date: 'not-a-date', tokensByModel: { x: 999 } },
  ],
  modelUsage: {
    'claude-opus-5-5': { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4 },
    'claude-fable-5': { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 40 },
    'claude-empty': { inputTokens: 0 },
  },
  totalMessages: 5,
};

test('Claude statistics give a lifetime total per model and per day', () => {
  const totals = readClaudeStats([statsDir(SAMPLE_STATS)]);
  assert.ok(totals);
  assert.equal(totals.scope, 'machine');
  assert.equal(totals.total, 110);
  assert.equal(totals.asOf, '2026-11-08');
  assert.deepEqual(totals.models?.['claude-fable-5'], [10, 20, 30, 40]);
  assert.equal(totals.models?.['claude-empty'], undefined);
  assert.deepEqual(totals.daily, { '2026-10-01': 150 });
});

test('an unusable statistics file counts as unavailable', () => {
  assert.equal(readClaudeStats([tempDir()]), null, 'missing');
  assert.equal(readClaudeStats([statsDir('{not json')]), null, 'corrupt');
  assert.equal(readClaudeStats([statsDir({ version: 99, somethingElse: true })]), null, 'unknown format');
  assert.equal(readClaudeStats([statsDir({ modelUsage: { a: { inputTokens: 'lots' } } })]), null, 'no usable numbers');
});

const CODEX_SCRIPT = `
const readline = require('node:readline');
const mode = process.argv[2];
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  const reply = (body) => process.stdout.write(JSON.stringify({ id: message.id, ...body }) + '\\n');
  if (message.method === 'initialize') {
    if (mode === 'init-error') return reply({ error: { message: 'no' } });
    process.stdout.write('not json at all\\n');
    return reply({ result: {} });
  }
  if (message.method !== 'account/usage/read') return;
  if (mode === 'usage-error') return reply({ error: { message: 'not signed in' } });
  if (mode === 'hang') return;
  if (mode === 'exit') return process.exit(0);
  if (mode === 'null') return reply({ result: { summary: { lifetimeTokens: null } } });
  reply({ result: {
    summary: { lifetimeTokens: 26308612616 },
    dailyUsageBuckets: [
      { startDate: '2026-07-11', tokens: 100 },
      { startDate: '2026-11-08', tokens: 200 },
      { startDate: 'garbage', tokens: 5 },
    ],
  } });
});
`;

function codexCommand(mode: string): string[] {
  const script = join(tempDir(), 'fake-codex.cjs');
  writeFileSync(script, CODEX_SCRIPT);
  return [process.execPath, script, mode];
}

test('Codex account usage comes through its app-server protocol', async () => {
  const totals = await readCodexAccount({ command: codexCommand('ok') });
  assert.ok(totals);
  assert.equal(totals.scope, 'account');
  assert.equal(totals.total, 26308612616);
  assert.equal(totals.asOf, '2026-11-08');
  assert.deepEqual(totals.daily, { '2026-07-11': 100, '2026-11-08': 200 });
});

test('Codex problems count as unavailable, and never hang or throw', async () => {
  assert.equal(await readCodexAccount({ command: ['/nonexistent/codex'] }), null, 'not installed');
  for (const mode of ['init-error', 'usage-error', 'exit', 'null']) {
    assert.equal(await readCodexAccount({ command: codexCommand(mode), timeoutMs: 5000 }), null, mode);
  }
  assert.equal(await readCodexAccount({ command: codexCommand('hang'), timeoutMs: 200 }), null, 'timeout');
});

test('totals only grow, known days survive, and a missing source changes nothing', () => {
  const before: ToolTotals = { scope: 'machine', total: 100, asOf: '2026-10-01', daily: { '2026-09-01': 40 } };
  const after: ToolTotals = { scope: 'machine', total: 150, asOf: '2026-11-01', daily: { '2026-11-01': 50 } };
  const merged = mergeTotals({ claude: before }, { claude: after }, undefined, {});
  assert.equal(merged?.claude.total, 150);
  assert.equal(merged?.claude.asOf, '2026-11-01');
  assert.deepEqual(merged?.claude.daily, { '2026-09-01': 40, '2026-11-01': 50 });
  assert.equal(mergeTotals({ claude: after }, { claude: before })?.claude.total, 150, 'never shrinks');
  assert.equal(mergeTotals(undefined, {}), undefined);
});

test('the ledger keeps totals through merging, saving and an unavailable source', async () => {
  const home = tempDir();
  const roots = { claude: [tempDir()], codex: [] };
  const totals = { claude: { scope: 'machine' as const, total: 500, asOf: '2026-11-08' } };
  await collectTokens(roots, home, 'UTC', () => {}, totals);
  const { ledger } = await collectTokens(roots, home, 'UTC', () => {}, {});
  assert.equal(ledger.totals?.claude.total, 500, 'an unavailable source keeps the last known total');
  const reloaded = JSON.parse(serializeLedger(ledger));
  assert.equal(reloaded.totals.claude.total, 500);
  const merged = mergeLedgers({ version: 1, days: {} }, reloaded);
  assert.equal(merged.totals?.claude.total, 500);
  assert.equal(mergeLedgers({ version: 1, days: {} }).totals, undefined);
  assert.ok(!('totals' in JSON.parse(serializeLedger({ version: 1, days: {} }))));
});

const PRICES: PriceTable = {
  'claude-opus-5-5': { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  'gpt-6-astra': { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
};

function realistic(): TokenLedger {
  return {
    version: 1,
    days: {
      '2026-10-20': { 'claude/claude-opus-5-5': [1, 1, 8, 0, 3], 'codex/gpt-6-astra': [2, 2, 6, 0, 4] },
      // Newer than either tool's own figure, so it must be added on top.
      '2026-11-09': { 'claude/claude-opus-5-5': [5, 0, 0, 0, 1], 'codex/gpt-6-astra': [7, 0, 0, 0, 1], 'claude/claude-new-model': [3, 0, 0, 0, 1] },
    },
    totals: {
      claude: {
        scope: 'machine',
        total: 1000,
        asOf: '2026-11-08',
        models: { 'claude-opus-5-5': [100, 100, 700, 0], 'claude-fable-5': [10, 10, 70, 10] },
        daily: { '2026-10-20': 600 },
      },
      codex: { scope: 'account', total: 500, asOf: '2026-11-08', daily: { '2026-10-20': 400, '2026-08-01': 100 } },
    },
  };
}

test('tool figures replace log totals, and newer logged usage is added on top', () => {
  const tokens = computeMetrics(null, realistic(), PRICES, TZ, NOW).tokens!;
  const row = (tool: string) => tokens.tools.find((item) => item.tool === tool)!;
  assert.equal(row('claude').total, 1008, '1000 from statistics, 8 newer from logs');
  assert.equal(row('claude').scope, 'machine');
  assert.equal(row('codex').total, 507, '500 from the account, 7 newer from logs');
  assert.equal(row('codex').scope, 'account');
  assert.equal(tokens.total, 1515);
});

test('per model: statistics win, new models come from logs, the rest has no model', () => {
  const tokens = computeMetrics(null, realistic(), PRICES, TZ, NOW).tokens!;
  const model = (name: string) => tokens.models.find((item) => item.model === name);
  assert.equal(model('claude-opus-5-5')?.total, 905, 'lifetime figure plus 5 newer');
  assert.equal(model('claude-opus-5-5')?.messages, 4, 'responses still come from logs');
  assert.equal(model('claude-fable-5')?.total, 100, 'only known from statistics, since its logs are gone');
  assert.equal(model('claude-new-model')?.total, 3);
  assert.equal(model('gpt-6-astra')?.total, 17);
  assert.equal(tokens.tools.find((item) => item.tool === 'codex')?.unattributed, 490, 'account total minus logged models');
  assert.equal(tokens.unattributed, 490);
});

test('cost covers what is known, and an account total adds no invented cost', () => {
  const tokens = computeMetrics(null, realistic(), PRICES, TZ, NOW).tokens!;
  assert.equal(tokens.cost, 205 + 11);
  assert.deepEqual(tokens.unpricedModels, ['claude-fable-5', 'claude-new-model']);
});

test('daily and monthly views use the larger known figure and report what is undated', () => {
  const tokens = computeMetrics(null, realistic(), PRICES, TZ, NOW).tokens!;
  const october = tokens.monthly.find((row) => row.month === '2026-10');
  assert.deepEqual(october?.byTool, { claude: 600, codex: 400 });
  assert.deepEqual(tokens.monthly.find((row) => row.month === '2026-08')?.byTool, { codex: 100 });
  assert.equal(tokens.daily.at(-1)?.byTool.claude, 8);
  assert.equal(tokens.firstDay, '2026-08-01');
  assert.deepEqual(tokens.peak, { date: '2026-10-20', total: 1000 });
  assert.equal(tokens.undated, 400, 'claude 1008 - 608 dated; codex fully dated');
});

test('months and undated usage add up to the total, even when sources disagree on the day', () => {
  const ledger = realistic();
  // The same usage, logged a day away from where the tool's own figure puts it.
  ledger.days['2026-10-21'] = { 'codex/gpt-6-astra': [90, 0, 300, 0, 1] };
  const tokens = computeMetrics(null, ledger, PRICES, TZ, NOW).tokens!;
  const months = tokens.monthly.reduce((sum, row) => sum + row.total, 0);
  assert.equal(months + tokens.undated, tokens.total);
  assert.equal(tokens.monthly.find((row) => row.month === '2026-10')?.byTool.codex, 400, 'the account figure, not figure plus log');
});

test('the headline drops the word tokens rather than clipping the numbers', () => {
  const claude: ToolTotals = { scope: 'machine', total: 40_660_000_000, asOf: null, models: { 'claude-opus-5-5': [1, 1, 40_659_999_998, 0] } };
  const headline = (codexTotal: number, price: number) => {
    const ledger: TokenLedger = { version: 1, days: {}, totals: { claude, codex: { scope: 'account', total: codexTotal, asOf: null } } };
    const prices: PriceTable = { 'claude-opus-5-5': { input: price, output: price, cacheRead: price, cacheWrite: price } };
    return buildCards(computeMetrics(null, ledger, prices, TZ, NOW))[0].hero[0];
  };
  assert.equal(headline(26_310_000_000, 1e-6), '67B tokens · ≥$40.7k API · Claude 40.7B Codex 26.3B');
  assert.equal(headline(26_410_000_000, 1e-6), '67.1B · ≥$40.7k API · Claude 40.7B Codex 26.4B');
});

test('the same ledger with no totals still works from logs alone', () => {
  const ledger = realistic();
  delete ledger.totals;
  const tokens = computeMetrics(null, ledger, PRICES, TZ, NOW).tokens!;
  assert.equal(tokens.total, 35);
  assert.equal(tokens.unattributed, 0);
  assert.equal(tokens.undated, 0);
  assert.ok(tokens.tools.every((row) => row.scope === 'logs'));
});

test('totals alone are enough, with no logs at all', () => {
  const ledger: TokenLedger = { version: 1, days: {}, totals: { codex: { scope: 'account', total: 26_300_000_000, asOf: null } } };
  const metrics = computeMetrics(null, ledger, {}, TZ, NOW);
  assert.equal(metrics.tokens?.total, 26_300_000_000);
  assert.equal(metrics.tokens?.unattributed, 26_300_000_000);
  assert.ok(buildCards(metrics)[0].hero[0].includes('26.3B'));
  assert.match(renderDashboard(metrics), /<\/svg>/);
});

test('the token card fits when pinned and states where its numbers come from', () => {
  const huge = realistic();
  huge.totals!.claude.total = 40_660_000_000_000;
  huge.totals!.codex.total = 26_310_000_000_000;
  huge.totals!.claude.models = { 'claude-opus-5-5-with-a-very-long-suffix': [1e12, 1e12, 3e13, 1e12] };
  const metrics = computeMetrics(null, huge, PRICES, TZ, NOW);
  const [card] = buildCards(metrics);
  assert.ok(card.hero.length <= CARD_LINES);
  for (const line of card.hero) assert.ok(displayWidth(line) <= CARD_WIDTH, line);

  const text = cardContent(buildCards(computeMetrics(null, realistic(), PRICES, TZ, NOW))[0], '2026-11-09');
  assert.match(text.split('\n')[0], /1\.5k tokens · ≥\$216 API · Claude 1k Codex 507/);
  assert.match(text, /its own statistics, this machine/);
  assert.match(text, /your account, every device/);
  assert.match(text, /Model unknown/);
  assert.match(text, /Earlier/);
});

test('the dashboard shows each tool with its reach', () => {
  const svg = renderDashboard(computeMetrics(null, realistic(), PRICES, TZ, NOW));
  assert.ok(svg.includes('Claude Code on this machine, Codex across the account'));
  assert.ok(!/NaN|undefined|Infinity/.test(svg));
});
