import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeMetrics, streaks } from '../src/metrics.ts';
import { buildCards, CARD_LINES, CARD_WIDTH, cardContent } from '../src/render/cards.ts';
import { renderHub, renderPreview } from '../src/render/report.ts';
import { renderDashboard } from '../src/render/svg.ts';
import { displayWidth } from '../src/util/format.ts';
import type { PriceTable, TokenLedger } from '../src/types.ts';
import { emptySnapshot, extremeLedger, extremeSnapshot } from './fixtures.ts';

const NOW = new Date('2026-11-09T05:00:00Z');
const TZ = 'Asia/Seoul';
const PRICES: PriceTable = {
  'claude-opus-5-5-with-a-long-suffix': { input: 4e-6, output: 2e-5, cacheRead: 2e-7, cacheWrite: 5e-6 },
  'gpt-6-astra': { input: 1e-6, output: 2e-6, cacheRead: null, cacheWrite: null },
};

function assertFits(lines: string[], context: string) {
  assert.ok(lines.length <= CARD_LINES, `${context}: ${lines.length} lines`);
  for (const line of lines) {
    assert.ok(displayWidth(line) <= CARD_WIDTH, `${context}: ${displayWidth(line)} cells: "${line}"`);
  }
}

test('every card fits the pinned preview even at extreme values', () => {
  const metrics = computeMetrics(extremeSnapshot(), extremeLedger(), PRICES, TZ, NOW);
  const cards = buildCards(metrics);
  assert.equal(cards.length, 7);
  for (const card of cards) assertFits(card.hero, card.key);
});

test('every card fits and renders with no data at all', () => {
  const metrics = computeMetrics(emptySnapshot(), { version: 1, days: {} }, {}, TZ, NOW);
  const cards = buildCards(metrics);
  assert.equal(cards.length, 6, 'no token card without token data');
  for (const card of cards) {
    assertFits(card.hero, card.key);
    assert.ok(cardContent(card, metrics.generatedDate).length > 0);
  }
  assert.match(renderDashboard(metrics), /<\/svg>/);
});

test('the summary comes first in a card file, then details', () => {
  const metrics = computeMetrics(extremeSnapshot(), null, {}, TZ, NOW);
  const [card] = buildCards(metrics);
  const lines = cardContent(card, '2026-11-09').split('\n');
  assert.deepEqual(lines.slice(0, card.hero.length), card.hero);
  assert.ok(lines.length > CARD_LINES);
});

test('card titles stay short enough for the pinned header', () => {
  const metrics = computeMetrics(extremeSnapshot(), extremeLedger(), PRICES, TZ, NOW);
  for (const card of buildCards(metrics)) {
    assert.ok(card.title.length <= 60, card.title);
  }
});

test('streaks tolerate an empty today but not an empty yesterday', () => {
  const days = (dates: string[]) => dates.map((date) => ({ date, count: 1 }));
  assert.equal(streaks(days(['2026-11-07', '2026-11-08']), '2026-11-09').current, 2);
  assert.equal(streaks(days(['2026-11-08', '2026-11-09']), '2026-11-09').current, 2);
  assert.equal(streaks(days(['2026-11-06', '2026-11-07']), '2026-11-09').current, 0);
  assert.equal(streaks(days(['2026-01-01', '2026-01-02', '2026-01-03', '2026-11-09']), '2026-11-09').best, 3);
  assert.deepEqual(streaks([], '2026-11-09'), { current: 0, best: 0 });
});

test('zero-count days do not extend a streak', () => {
  const calendar = [
    { date: '2026-11-07', count: 1 },
    { date: '2026-11-08', count: 0 },
    { date: '2026-11-09', count: 1 },
  ];
  assert.equal(streaks(calendar, '2026-11-09').current, 1);
});

test('rhythm buckets use local time and sum to all events', () => {
  const snapshot = emptySnapshot({
    commits: [
      // 15:00 UTC is midnight in Seoul, so night, not daytime.
      { oid: 'a', at: '2026-05-05T15:00:00Z', scope: 'personal', add: 0, del: 0, merge: false, ai: null, kind: null },
      // 00:00 UTC is 09:00 in Seoul.
      { oid: 'b', at: '2026-05-05T00:00:00Z', scope: 'org', add: 0, del: 0, merge: false, ai: null, kind: null },
    ],
    pulls: [{ createdAt: '2026-05-05T05:00:00Z', mergedAt: null, closedAt: null, add: 0, del: 0, scope: 'org' }],
    reviews: [{ at: '2026-05-05T11:00:00Z', prCreatedAt: '2026-05-05T10:00:00Z', scope: 'org' }],
  });
  const { rhythm, scopes, counts } = computeMetrics(snapshot, null, {}, TZ, NOW).github!;
  const by = Object.fromEntries(rhythm.buckets.map((bucket) => [bucket.key, bucket.count]));
  assert.deepEqual(by, { morning: 1, daytime: 1, evening: 1, night: 1 });
  assert.equal(rhythm.total, 4);
  assert.equal(scopes.org.commits, 1);
  assert.equal(scopes.personal.commits, 1);
  assert.equal(counts.attributed, 4);
});

test('churn excludes docs and skipped files from language rows', () => {
  const snapshot = emptySnapshot({
    commits: [{ oid: 'a', at: '2026-05-05T00:00:00Z', scope: 'personal', add: 0, del: 0, merge: false, ai: null, kind: null }],
    churn: { a: { TypeScript: [10, 2], 'Docs & data': [5, 1], Skipped: [100, 50] } },
  });
  const { churn } = computeMetrics(snapshot, null, {}, TZ, NOW).github!;
  assert.deepEqual(churn.rows, [{ name: 'TypeScript', add: 10, del: 2, net: 8 }]);
  assert.deepEqual(churn.docs, { add: 5, del: 1 });
  assert.equal(churn.skipped, 150);
});

test('a bulk import is left out of churn and languages, and reported', () => {
  const commit = (oid: string) => ({ oid, at: '2026-05-05T00:00:00Z', scope: 'org' as const, add: 0, del: 0, merge: false, ai: null, kind: null });
  const snapshot = emptySnapshot({
    commits: [commit('sdk'), commit('real')],
    churn: { sdk: { C: [250_000, 10] }, real: { TypeScript: [900, 100], C: [50, 5] } },
    languages: [{ name: 'C', color: null, personal: 0, org: 99_000_000, external: 0, gist: 0, gistLines: 0 }],
  });
  const { churn, languages } = computeMetrics(snapshot, null, {}, TZ, NOW).github!;
  assert.deepEqual(churn.bulk, { commits: 1, lines: 250_010 });
  assert.equal(churn.rows.find((row) => row.name === 'C')?.add, 50);
  // Huge in bytes, tiny in authored lines: TypeScript still leads.
  assert.deepEqual(languages.map((row) => row.name), ['TypeScript', 'C']);
  assert.equal(languages[0].org, 900);
  assert.equal(languages[1].bytes, 99_000_000);

  const raised = computeMetrics(snapshot, null, {}, TZ, NOW, { maxCommitLines: 1_000_000 }).github!;
  assert.equal(raised.churn.bulk.commits, 0);
  assert.equal(raised.languages[0].name, 'C');
});

test('top languages combine commit lines and gist lines, and honor exclusions', () => {
  const snapshot = emptySnapshot({
    commits: [{ oid: 'a', at: '2026-05-05T00:00:00Z', scope: 'personal', add: 0, del: 0, merge: false, ai: null, kind: null }],
    churn: { a: { Python: [10, 0], Ruby: [999, 0] } },
    languages: [
      { name: 'Python', color: null, personal: 1, org: 0, external: 0, gist: 40, gistLines: 5 },
      { name: 'Lua', color: null, personal: 0, org: 0, external: 0, gist: 20, gistLines: 2 },
    ],
  });
  const { languages, languageTotals, churn } = computeMetrics(snapshot, null, {}, TZ, NOW, { excludeLanguages: ['ruby'] }).github!;
  assert.deepEqual(
    languages.map((row) => [row.name, row.lines, row.personal, row.gist]),
    [
      ['Python', 15, 10, 5],
      ['Lua', 2, 0, 2],
    ],
  );
  assert.deepEqual(languageTotals, { personal: 10, org: 0, external: 0, gist: 7 });
  assert.ok(!churn.rows.some((row) => row.name === 'Ruby'));
});

test('token totals separate cache reads and report unpriced models', () => {
  const ledger: TokenLedger = {
    version: 1,
    days: {
      '2026-11-09': {
        'claude/priced': [10, 20, 1000, 30, 1],
        'codex/unknown-model': [1, 1, 1, 1, 1],
      },
    },
  };
  const prices: PriceTable = { priced: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
  const tokens = computeMetrics(null, ledger, prices, TZ, NOW).tokens!;
  assert.equal(tokens.total, 1064);
  assert.equal(tokens.fresh, 63);
  assert.equal(tokens.cost, 30);
  assert.deepEqual(tokens.unpricedModels, ['unknown-model']);
  assert.equal(tokens.daily.length, 60);
  assert.equal(tokens.daily.at(-1)?.total, 1064);
});

test('a token card alone renders without GitHub data', () => {
  const metrics = computeMetrics(null, extremeLedger(), PRICES, TZ, NOW);
  const cards = buildCards(metrics);
  assert.deepEqual(cards.map((card) => card.key), ['tokens']);
  assert.match(cards[0].hero[0], /tokens/);
  assert.match(cards[0].details.join('\n'), /No public price for: an-unpriced-model, fourth-model/);
});

test('the headline is this year on the GitHub graph, with lifetime beneath it', () => {
  const commit = (oid: string, at: string) => ({ oid, at, scope: 'org' as const, add: 0, del: 0, merge: false, ai: null, kind: null });
  const snapshot = emptySnapshot({
    calendar: [
      { date: '2025-12-31', count: 361 },
      { date: '2026-09-01', count: 1933 },
      { date: '2026-10-01', count: 1202 },
    ],
    commits: [commit('old', '2025-06-01T00:00:00Z'), commit('a', '2026-09-01T00:00:00Z'), commit('b', '2026-09-02T00:00:00Z')],
  });
  const metrics = computeMetrics(snapshot, null, {}, TZ, NOW);
  assert.equal(metrics.github?.thisYear.calendar, 3135);
  assert.equal(metrics.github?.counts.calendar, 3496);

  const svg = renderDashboard(metrics);
  assert.ok(svg.includes('>3,135</text>'), 'this year is the headline');
  assert.ok(svg.includes('contributions in 2026'));
  assert.ok(svg.includes('3,496 lifetime contributions'));
  assert.ok(svg.includes('>2</text>'), 'tiles lead with this year too');
  assert.ok(svg.includes('3 lifetime · 12 months'));

  const [card] = buildCards(metrics);
  assert.equal(card.title, '⚡ Contributions: 3.1k in 2026 · 3.5k lifetime');
  assert.match(card.hero[0], /2026 +lifetime +last 12 months/);
  assert.match(card.hero[1], /^Commits +2 +3 /);
});

test('the dashboard is well-formed and escapes text', () => {
  const snapshot = extremeSnapshot();
  snapshot.languages[0].name = 'A<b>&"C';
  snapshot.languages[0].gistLines = 99_999_999;
  const svg = renderDashboard(computeMetrics(snapshot, extremeLedger(), PRICES, TZ, NOW));
  assert.ok(svg.includes('A&lt;b&gt;&amp;&quot;C'));
  assert.ok(!svg.includes('A<b>'));
  assert.ok(!/NaN|undefined|Infinity/.test(svg), 'no broken geometry');
  assert.ok(svg.includes('prefers-color-scheme: dark'));
  assert.equal((svg.match(/<svg/g) ?? []).length, 1);
});

test('hub report and preview include every card', () => {
  const metrics = computeMetrics(extremeSnapshot(), extremeLedger(), PRICES, TZ, NOW);
  const cards = buildCards(metrics);
  const hub = renderHub('octo', cards, metrics.generatedDate, {
    cards: { tokens: 'https://gist.github.com/octo/abc' },
    dashboardUrl: 'https://gist.githubusercontent.com/octo/hub/raw/dashboard.svg',
  });
  for (const card of cards) assert.ok(hub.includes(card.title), card.key);
  assert.ok(hub.includes('![Developer dashboard](https://gist.githubusercontent.com/octo/hub/raw/dashboard.svg)'));
  assert.ok(hub.includes('(https://gist.github.com/octo/abc)'));
  const preview = renderPreview(cards, renderDashboard(metrics));
  assert.ok(preview.includes('data:image/svg+xml;base64,'));
  assert.equal((preview.match(/class="pin"/g) ?? []).length, cards.length);
});
