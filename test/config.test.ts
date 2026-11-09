import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';

function home(config?: object): string {
  const dir = mkdtempSync(join(tmpdir(), 'omg-config-'));
  if (config) writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  return dir;
}

test('the shipped defaults hold no personal settings', () => {
  const defaults = JSON.parse(readFileSync(resolve(import.meta.dirname, '../oh-my-gist.config.json'), 'utf8'));
  assert.equal(defaults.timezone, 'auto');
  assert.deepEqual(defaults.namedCoauthors, []);
  assert.deepEqual(defaults.agentCoauthors, []);
  assert.deepEqual(defaults.excludeLanguages, []);
});

test('with no personal config, the shipped defaults apply', () => {
  const config = loadConfig({ OMG_HOME: home() });
  assert.deepEqual(config.agentCoauthors, []);
  assert.equal(config.churn.maxCommitLines, 20000);
  assert.equal(config.timezone, Intl.DateTimeFormat().resolvedOptions().timeZone);
});

test('a config in the state folder beats the shipped defaults', () => {
  const config = loadConfig({ OMG_HOME: home({ timezone: 'Asia/Seoul', agentCoauthors: ['my-agent'] }) });
  assert.equal(config.timezone, 'Asia/Seoul');
  assert.deepEqual(config.agentCoauthors, ['my-agent']);
  assert.equal(config.churn.concurrency, 8, 'unset keys keep their defaults');
});

test('OMG_CONFIG beats the state folder, and OMG_CONFIG_JSON beats both', () => {
  const dir = home({ timezone: 'Asia/Seoul' });
  const path = join(dir, 'other.json');
  writeFileSync(path, JSON.stringify({ timezone: 'Europe/Paris' }));
  assert.equal(loadConfig({ OMG_HOME: dir, OMG_CONFIG: path }).timezone, 'Europe/Paris');
  assert.equal(loadConfig({ OMG_HOME: dir, OMG_CONFIG: path, OMG_CONFIG_JSON: '{"timezone":"Asia/Tokyo"}' }).timezone, 'Asia/Tokyo');
});

test('OMG_TIMEZONE overrides any config', () => {
  assert.equal(loadConfig({ OMG_HOME: home({ timezone: 'Asia/Seoul' }), OMG_TIMEZONE: 'UTC' }).timezone, 'UTC');
});

test('variables Actions leaves unset arrive empty and are ignored', () => {
  const config = loadConfig({ OMG_HOME: home({ timezone: 'Asia/Seoul' }), OMG_TIMEZONE: '', OMG_CONFIG_JSON: '', OMG_CONFIG: '', OMG_OUT: '' });
  assert.equal(config.timezone, 'Asia/Seoul');
  assert.equal(config.outDir, resolve(import.meta.dirname, '../out'));
});

test('bad configuration fails with a message that names the cause', () => {
  assert.throws(() => loadConfig({ OMG_HOME: home(), OMG_CONFIG_JSON: '{nope' }), /Could not parse config from OMG_CONFIG_JSON/);
  assert.throws(() => loadConfig({ OMG_HOME: home(), OMG_CONFIG: '/nonexistent/x.json' }), /missing file/);
  assert.throws(() => loadConfig({ OMG_HOME: home(), OMG_TIMEZONE: 'Mars/Olympus' }), /Invalid timezone "Mars\/Olympus"/);
});
