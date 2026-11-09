import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bar, bytes, clip, compact, displayWidth, hours, money, sparkline } from '../src/util/format.ts';
import { lastDays, lastMonths, median, zoned } from '../src/util/time.ts';

test('bar is always exactly the requested width', () => {
  for (const fraction of [0, 0.001, 0.26, 0.5, 0.999, 1, 2, -1, Number.NaN]) {
    assert.equal([...bar(fraction, 20)].length, 20, `fraction ${fraction}`);
  }
  assert.equal(bar(1, 4), '████');
  assert.equal(bar(0, 4), '░░░░');
  assert.equal(bar(0.5, 4), '██░░');
});

test('sparkline keeps faint activity above the floor', () => {
  assert.equal(sparkline([0, 0]), '▁▁');
  const line = [...sparkline([0, 1, 1000])];
  assert.equal(line[0], '▁');
  assert.notEqual(line[1], '▁');
  assert.equal(line[2], '█');
});

test('number formats stay compact', () => {
  assert.equal(compact(999), '999');
  assert.equal(compact(1234), '1.2k');
  assert.equal(compact(8_056_779_313), '8.1B');
  assert.equal(compact(120_000), '120k');
  assert.equal(money(4321), '$4.3k');
  assert.equal(money(0.5), '$0.50');
  assert.equal(bytes(31_380_000), '31.38 MB');
  assert.equal(hours(0.5), '30m');
  assert.equal(hours(5), '5h');
  assert.equal(hours(72), '3d');
  assert.equal(hours(null), 'n/a');
});

test('displayWidth counts pictographs as two cells and clip respects it', () => {
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth('🔥 x'), 4);
  assert.ok(displayWidth(clip('a very long language name', 10)) <= 10);
});

test('zoned converts UTC to wall-clock time in the configured zone', () => {
  const seoul = zoned('2026-01-01T15:30:00Z', 'Asia/Seoul');
  assert.equal(seoul.date, '2026-01-02');
  assert.equal(seoul.hour, 0);
  assert.equal(seoul.weekday, 4); // Friday, Monday = 0
  assert.equal(zoned('2026-01-01T15:30:00Z', 'UTC').hour, 15);
});

test('date windows include their end and cross year boundaries', () => {
  assert.deepEqual(lastMonths('2026-02', 3), ['2025-12', '2026-01', '2026-02']);
  assert.deepEqual(lastDays('2026-03-01', 2), ['2026-02-28', '2026-03-01']);
});

test('median handles empty, odd and even input', () => {
  assert.equal(median([]), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
});
