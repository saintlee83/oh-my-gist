import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { zstdCompressSync } from 'node:zlib';
import { collectTokens, ledgerFromEvents, mergeLedgers, serializeLedger, type LogRoots } from '../src/tokens/ledger.ts';
import { mergeEvents, parseClaudeLog, parseCodexLog } from '../src/tokens/parsers.ts';
import { costOf, findPrice, trimPrices } from '../src/tokens/pricing.ts';
import type { TokenLedger } from '../src/types.ts';

const SECRET = 'TOP-SECRET-PROMPT-CONTENT';
const SECRET_PATH = '/Users/someone/private-client-project';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'omg-test-'));
}

function claudeRow(id: string, request: string, output: number, overrides: object = {}) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: '2026-11-08T23:30:00.000Z',
    requestId: request,
    cwd: SECRET_PATH,
    message: {
      id,
      model: 'claude-opus-5-5',
      content: [{ type: 'text', text: SECRET }],
      usage: { input_tokens: 2, output_tokens: output, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 },
    },
    ...overrides,
  });
}

test('Claude rows repeating a response collapse to its finished row', async () => {
  const dir = tempDir();
  const path = join(dir, 'a.jsonl');
  writeFileSync(
    path,
    [
      claudeRow('m1', 'r1', 5),
      claudeRow('m1', 'r1', 40), // Same response, later and more complete.
      claudeRow('m2', 'r2', 7),
      JSON.stringify({ type: 'user', message: { content: SECRET } }),
      '{"truncated line with "usage" in it',
    ].join('\n'),
  );
  const merged = mergeEvents(await parseClaudeLog(path));
  assert.equal(merged.length, 2);
  assert.equal(merged.find((event) => event.key.startsWith('m1'))?.output, 40);
});

test('synthetic Claude rows are not usage', async () => {
  const dir = tempDir();
  const path = join(dir, 'a.jsonl');
  writeFileSync(
    path,
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-11-08T00:00:00Z',
      message: { id: 'x', model: '<synthetic>', usage: { input_tokens: 9, output_tokens: 9 } },
    }),
  );
  assert.equal((await parseClaudeLog(path)).length, 0);
});

function codexRecord(id: string, input: number, cached: number, output: number) {
  return JSON.stringify({
    type: 'token_usage_record',
    timestamp: '2026-11-08T10:00:00Z',
    payload: {
      response_id: id,
      usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, total_tokens: input + output },
    },
  });
}

function codexCount(total: number, last: number) {
  return JSON.stringify({
    type: 'event_msg',
    timestamp: '2026-11-08T10:00:00Z',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { total_tokens: total },
        last_token_usage: { input_tokens: last, cached_input_tokens: 0, output_tokens: 0, total_tokens: last },
      },
    },
  });
}

const turnContext = (model: string) => JSON.stringify({ type: 'turn_context', timestamp: 't', payload: { model, cwd: SECRET_PATH } });

test('Codex input is normalized to exclude cached tokens', async () => {
  const path = join(tempDir(), 'a.jsonl');
  writeFileSync(path, [turnContext('gpt-6-astra'), codexRecord('r1', 1000, 800, 50)].join('\n'));
  const [event] = await parseCodexLog(path);
  assert.equal(event.input, 200);
  assert.equal(event.cacheRead, 800);
  assert.equal(event.output, 50);
  assert.equal(event.model, 'gpt-6-astra');
});

test('Codex usage logged before the first turn_context still gets its model', async () => {
  const path = join(tempDir(), 'a.jsonl');
  writeFileSync(path, [codexRecord('r1', 10, 0, 1), turnContext('gpt-6-astra'), codexRecord('r2', 10, 0, 1)].join('\n'));
  const events = await parseCodexLog(path);
  assert.deepEqual(events.map((event) => event.model), ['gpt-6-astra', 'gpt-6-astra']);
});

test('Codex records and token_count events for one response are not added together', async () => {
  const path = join(tempDir(), 'a.jsonl');
  writeFileSync(path, [turnContext('m'), codexRecord('r1', 100, 0, 1), codexCount(101, 101)].join('\n'));
  assert.equal((await parseCodexLog(path)).length, 1);
});

test('older Codex logs dedupe repeated token_count events', async () => {
  const path = join(tempDir(), 'a.jsonl');
  writeFileSync(path, [turnContext('m'), codexCount(100, 100), codexCount(100, 100), codexCount(150, 50)].join('\n'));
  const events = await parseCodexLog(path);
  assert.deepEqual(events.map((event) => event.input), [100, 50]);
});

test('compressed Codex logs are read', async () => {
  const path = join(tempDir(), 'a.jsonl.zst');
  writeFileSync(path, zstdCompressSync(Buffer.from([turnContext('m'), codexRecord('r1', 10, 0, 1)].join('\n'))));
  assert.equal((await parseCodexLog(path)).length, 1);
});

test('a corrupt compressed log fails on its own', async () => {
  const path = join(tempDir(), 'a.jsonl.zst');
  writeFileSync(path, 'this is not zstd');
  await assert.rejects(parseCodexLog(path));
});

test('ledger days use the configured timezone', () => {
  const ledger = ledgerFromEvents(
    [{ key: 'k', at: '2026-11-08T23:30:00Z', tool: 'claude', model: 'm', input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }],
    'Asia/Seoul',
  );
  assert.deepEqual(Object.keys(ledger.days), ['2026-11-09']);
  assert.deepEqual(ledger.days['2026-11-09']['claude/m'], [1, 2, 3, 4, 1]);
});

test('ledger keeps history after assistants delete old logs', () => {
  const before: TokenLedger = { version: 1, days: { '2026-01-01': { 'claude/m': [10, 10, 10, 10, 5] } } };
  const afterPruning: TokenLedger = { version: 1, days: { '2026-01-01': { 'claude/m': [1, 1, 1, 1, 1] } } };
  const today: TokenLedger = { version: 1, days: { '2026-11-09': { 'claude/m': [2, 2, 2, 2, 2] } } };
  const merged = mergeLedgers(before, afterPruning, today);
  assert.deepEqual(merged.days['2026-01-01']['claude/m'], [10, 10, 10, 10, 5]);
  assert.deepEqual(merged.days['2026-11-09']['claude/m'], [2, 2, 2, 2, 2]);
});

test('ledger picks up new usage on an existing day', () => {
  const morning: TokenLedger = { version: 1, days: { '2026-11-09': { 'claude/m': [1, 1, 1, 1, 1] } } };
  const evening: TokenLedger = { version: 1, days: { '2026-11-09': { 'claude/m': [5, 5, 5, 5, 3] } } };
  assert.deepEqual(mergeLedgers(morning, evening).days['2026-11-09']['claude/m'], [5, 5, 5, 5, 3]);
});

test('nothing from the logs except numbers and model names is persisted', async () => {
  const home = tempDir();
  const logs = tempDir();
  const claudeRoot = join(logs, 'claude', SECRET_PATH.replaceAll('/', '-'));
  const codexRoot = join(logs, 'codex');
  mkdirSync(claudeRoot, { recursive: true });
  mkdirSync(codexRoot, { recursive: true });
  writeFileSync(join(claudeRoot, 'session.jsonl'), claudeRow('m1', 'r1', 5));
  writeFileSync(join(codexRoot, 'session.jsonl'), [turnContext('gpt-6-astra'), codexRecord('r1', 10, 0, 1)].join('\n'));
  const roots: LogRoots = { claude: [join(logs, 'claude')], codex: [codexRoot] };

  const { ledger } = await collectTokens(roots, home, 'UTC');
  const published = serializeLedger(ledger);
  const cached = readFileSync(join(home, 'token-files.json'), 'utf8');
  for (const output of [published, cached]) {
    assert.ok(!output.includes(SECRET));
    assert.ok(!output.includes('private-client-project'));
  }
  assert.ok(published.includes('claude/claude-opus-5-5'));
});

test('unchanged logs are served from the cache', async () => {
  const home = tempDir();
  const root = tempDir();
  writeFileSync(join(root, 'a.jsonl'), claudeRow('m1', 'r1', 5));
  const roots: LogRoots = { claude: [root], codex: [] };
  assert.equal((await collectTokens(roots, home, 'UTC')).scan.parsed, 1);
  const second = await collectTokens(roots, home, 'UTC');
  assert.equal(second.scan.parsed, 0);
  assert.equal(second.scan.events.length, 1);
});

test('prices resolve dated and provider-prefixed names, and caching falls back to input price', () => {
  const prices = trimPrices({
    'claude-opus-5-5': { input_cost_per_token: 4e-6, output_cost_per_token: 2e-5, cache_read_input_token_cost: 2e-7, cache_creation_input_token_cost: 5e-6 },
    'openai/gpt-x': { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
    'image-model': { output_cost_per_token: 1 } as never,
  });
  assert.ok(findPrice(prices, 'claude-opus-5-5-20270101'));
  assert.ok(findPrice(prices, 'gpt-x'));
  assert.equal(findPrice(prices, 'image-model'), null);
  const cost = costOf(prices['openai/gpt-x'], { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 });
  assert.ok(Math.abs(cost - 5e-6) < 1e-12);
});
