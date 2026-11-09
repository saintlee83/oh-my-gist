import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { promisify } from 'node:util';
import { emptySnapshot, extremeLedger, extremeSnapshot } from './fixtures.ts';

const run = promisify(execFile);
const CLI = resolve(import.meta.dirname, '../src/cli.ts');

interface StoredGist {
  id: string;
  html_url: string;
  description: string;
  public: boolean;
  files: Record<string, { filename: string; content: string }>;
}

/** Just enough of the GitHub gist API to exercise the real CLI end to end. */
class MockGitHub {
  gists = new Map<string, StoredGist>();
  writes: { method: string; id: string }[] = [];
  /** Sent as x-oauth-scopes when set, the way GitHub does for classic tokens. */
  scopes: string | null = null;
  private server: Server | null = null;
  private counter = 0;
  url = '';

  async start() {
    this.server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        const send = (status: number, data: unknown) => {
          response.writeHead(status, {
            'content-type': 'application/json',
            ...(this.scopes === null ? {} : { 'x-oauth-scopes': this.scopes }),
          });
          response.end(JSON.stringify(data));
        };
        const path = (request.url ?? '').split('?')[0];
        const method = request.method ?? 'GET';
        const id = path.split('/')[2];
        if (method === 'GET' && path === '/gists') return send(200, [...this.gists.values()]);
        if (method === 'GET' && this.gists.has(id)) return send(200, this.gists.get(id));
        const input = body ? JSON.parse(body) : {};
        const files = () =>
          Object.fromEntries(
            Object.entries<{ content: string }>(input.files).map(([name, file]) => [name, { filename: name, content: file.content }]),
          );
        if (method === 'POST' && path === '/gists') {
          const created: StoredGist = {
            id: `gist${++this.counter}`,
            html_url: `https://gist.github.com/octo/gist${this.counter}`,
            description: input.description,
            public: input.public,
            files: files(),
          };
          this.gists.set(created.id, created);
          this.writes.push({ method, id: created.id });
          return send(201, created);
        }
        if (method === 'PATCH' && this.gists.has(id)) {
          const gist = this.gists.get(id) as StoredGist;
          gist.description = input.description;
          Object.assign(gist.files, files());
          this.writes.push({ method, id });
          return send(200, gist);
        }
        return send(404, { message: `Not found: ${method} ${path}` });
      });
    });
    await new Promise<void>((done) => this.server?.listen(0, '127.0.0.1', done));
    this.url = `http://127.0.0.1:${(this.server?.address() as AddressInfo).port}`;
  }

  stop() {
    this.server?.close();
  }

  find(filename: string): StoredGist | undefined {
    return [...this.gists.values()].find((gist) => filename in gist.files);
  }

  reset() {
    this.gists.clear();
    this.writes = [];
    this.scopes = null;
  }
}

const github = new MockGitHub();
before(() => github.start());
after(() => github.stop());
beforeEach(() => github.reset());

function makeHome(options: { snapshot?: boolean; ledger?: boolean } = { snapshot: true, ledger: true }): string {
  const home = mkdtempSync(join(tmpdir(), 'omg-cli-'));
  if (options.snapshot) writeFileSync(join(home, 'snapshot.json'), JSON.stringify(extremeSnapshot()));
  if (options.ledger) writeFileSync(join(home, 'token-ledger.json'), JSON.stringify(extremeLedger()));
  // A fresh price cache keeps the test off the network.
  writeFileSync(join(home, 'prices.json'), JSON.stringify({ 'gpt-6-astra': { input: 1e-6, output: 2e-6, cacheRead: null, cacheWrite: null } }));
  return home;
}

async function cli(home: string, ...args: string[]) {
  const env = {
    ...process.env,
    OMG_HOME: home,
    OMG_OUT: join(home, 'out'),
    OMG_API_URL: github.url,
    OH_MY_GIST_TOKEN: 'test-token',
    OMG_TIMEZONE: 'Asia/Seoul',
    NODE_NO_WARNINGS: '1',
  };
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { env });
    return { code: 0, output: stdout + stderr };
  } catch (error) {
    const failure = error as { code: number; stdout: string; stderr: string };
    return { code: failure.code, output: failure.stdout + failure.stderr };
  }
}

test('publishing needs --yes and writes nothing without it', async () => {
  const result = await cli(makeHome(), 'publish');
  assert.equal(result.code, 1);
  assert.match(result.output, /Nothing was published/);
  assert.equal(github.writes.length, 0);
});

test('a token that cannot write gists stops before any write', async () => {
  github.scopes = 'repo, read:org';
  const result = await cli(makeHome(), 'publish', '--yes');
  assert.equal(result.code, 1);
  assert.match(result.output, /missing the gist scope/);
  assert.deepEqual(github.writes, []);
});

test('a dry run writes nothing, even with --yes', async () => {
  const result = await cli(makeHome(), 'publish', '--dry-run', '--yes');
  assert.equal(result.code, 0);
  assert.match(result.output, /would-create/);
  assert.equal(github.writes.length, 0);
});

test('--yes creates seven public cards and a hub linking them', async () => {
  const result = await cli(makeHome(), 'publish', '--yes');
  assert.equal(result.code, 0, result.output);
  assert.equal(github.gists.size, 8);
  assert.ok([...github.gists.values()].every((gist) => gist.public));

  const hub = github.find('00-oh-my-gist.md') as StoredGist;
  assert.ok(hub.files['dashboard.svg'].content.includes('</svg>'));
  const report = hub.files['00-oh-my-gist.md'].content;
  assert.ok(report.includes(`gist.githubusercontent.com/octo/${hub.id}/raw/dashboard.svg`), 'embeds its own dashboard');

  const languages = github.find('oh-my-gist-languages.txt') as StoredGist;
  assert.ok(report.includes(languages.html_url), 'links each card');
  assert.match(languages.description, /Top languages/);

  // GitHub pins the first file alphabetically, so the card must sort before the ledger.
  const tokens = github.find('oh-my-gist-tokens.txt') as StoredGist;
  assert.deepEqual(Object.keys(tokens.files).sort(), ['oh-my-gist-tokens.txt', 'tokens-ledger.json']);
});

test('publishing twice with the same data adds no revisions', async () => {
  const home = makeHome();
  await cli(home, 'publish', '--yes');
  github.writes = [];
  const result = await cli(home, 'publish');
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(github.writes, []);
  assert.match(result.output, /unchanged/);
});

test('changed data updates the existing gists rather than making new ones', async () => {
  const home = makeHome();
  await cli(home, 'publish', '--yes');
  github.writes = [];
  const snapshot = extremeSnapshot();
  snapshot.totals.followers = 999_000;
  writeFileSync(join(home, 'snapshot.json'), JSON.stringify(snapshot));
  const result = await cli(home, 'publish');
  assert.equal(result.code, 0, result.output);
  assert.equal(github.gists.size, 8);
  assert.ok(github.writes.length > 0);
  assert.ok(github.writes.every((write) => write.method === 'PATCH'));
});

test('--update-only leaves a deleted card deleted and still updates the rest', async () => {
  const home = makeHome();
  await cli(home, 'publish', '--yes');
  const pulse = github.find('oh-my-gist-pulse.txt') as StoredGist;
  github.gists.delete(pulse.id);
  github.writes = [];

  const snapshot = extremeSnapshot();
  snapshot.coverage.gists = 321;
  writeFileSync(join(home, 'snapshot.json'), JSON.stringify(snapshot));

  const result = await cli(home, 'publish', '--update-only');
  assert.equal(result.code, 0, result.output);
  assert.equal(github.find('oh-my-gist-pulse.txt'), undefined);
  assert.ok(github.writes.length > 0, 'other cards still update');
  assert.ok(github.writes.every((write) => write.method === 'PATCH'));
  assert.match((github.find('oh-my-gist-languages.txt') as StoredGist).files['oh-my-gist-languages.txt'].content, /321 scanned/);
});

test('without --update-only, a missing card blocks and writes nothing', async () => {
  const home = makeHome();
  await cli(home, 'publish', '--yes');
  github.gists.delete((github.find('oh-my-gist-pulse.txt') as StoredGist).id);
  github.writes = [];
  const result = await cli(home, 'publish');
  assert.equal(result.code, 1);
  assert.deepEqual(github.writes, []);
});

test('--update-only with no gists yet explains what to do', async () => {
  const result = await cli(makeHome(), 'publish', '--update-only');
  assert.equal(result.code, 0);
  assert.match(result.output, /publish --yes/);
  assert.deepEqual(github.writes, []);
});

test('--tokens-only touches only the token gist', async () => {
  const home = makeHome();
  await cli(home, 'publish', '--yes');
  const before = (github.find('oh-my-gist-tokens.txt') as StoredGist).files['tokens-ledger.json'].content;
  github.writes = [];

  const ledger = extremeLedger();
  ledger.days['2026-11-09']['codex/gpt-6-astra'] = [5, 5, 5, 5, 5];
  writeFileSync(join(home, 'token-ledger.json'), JSON.stringify(ledger));

  const result = await cli(home, 'publish', '--tokens-only');
  assert.equal(result.code, 0, result.output);
  const tokens = github.find('oh-my-gist-tokens.txt') as StoredGist;
  assert.deepEqual(github.writes, [{ method: 'PATCH', id: tokens.id }]);
  assert.notEqual(tokens.files['tokens-ledger.json'].content, before);
});

test('--github-only keeps token data from the published ledger, as CI must', async () => {
  const laptop = makeHome();
  await cli(laptop, 'publish', '--yes');
  const tokens = github.find('oh-my-gist-tokens.txt') as StoredGist;
  const published = tokens.files['tokens-ledger.json'].content;
  github.writes = [];

  // A CI runner has a snapshot but no local AI logs or ledger.
  const runner = makeHome({ snapshot: true, ledger: false });
  const snapshot = extremeSnapshot();
  snapshot.totals.followers = 12_345;
  writeFileSync(join(runner, 'snapshot.json'), JSON.stringify(snapshot));
  const result = await cli(runner, 'publish', '--github-only');
  assert.equal(result.code, 0, result.output);

  assert.ok(!github.writes.some((write) => write.id === tokens.id), 'token gist untouched');
  assert.equal(tokens.files['tokens-ledger.json'].content, published);
  const hub = github.find('00-oh-my-gist.md') as StoredGist;
  assert.match(hub.files['00-oh-my-gist.md'].content, /AI token trace/, 'hub keeps the token section');
  assert.match(hub.files['dashboard.svg'].content, /AI token trace/);
});

test('tool totals are published and survive CI runs, which have no local tools', async () => {
  const laptop = makeHome();
  const ledger = { version: 1, days: {}, totals: { codex: { scope: 'account', total: 26_300_000_000, asOf: null } } };
  writeFileSync(join(laptop, 'token-ledger.json'), JSON.stringify(ledger));
  await cli(laptop, 'publish', '--yes');
  const tokens = github.find('oh-my-gist-tokens.txt') as StoredGist;
  assert.equal(JSON.parse(tokens.files['tokens-ledger.json'].content).totals.codex.total, 26_300_000_000);
  assert.match(tokens.description, /26\.3B/);

  const result = await cli(makeHome({ snapshot: true, ledger: false }), 'publish', '--github-only');
  assert.equal(result.code, 0, result.output);
  const hub = github.find('00-oh-my-gist.md') as StoredGist;
  assert.match(hub.files['00-oh-my-gist.md'].content, /AI token trace: 26\.3B/);
  assert.match(hub.files['dashboard.svg'].content, /26\.3B/);
});

test('a machine that lost its ledger recovers history from the published copy', async () => {
  const home = makeHome();
  await cli(home, 'publish', '--yes');
  const fresh = makeHome({ snapshot: true, ledger: false });
  writeFileSync(join(fresh, 'token-ledger.json'), JSON.stringify({ version: 1, days: { '2026-11-09': { 'claude/new': [1, 1, 1, 1, 1] } } }));
  const result = await cli(fresh, 'publish');
  assert.equal(result.code, 0, result.output);
  const merged = JSON.parse((github.find('oh-my-gist-tokens.txt') as StoredGist).files['tokens-ledger.json'].content);
  assert.ok(merged.days['2026-11-08'], 'older history survived');
  assert.ok(merged.days['2026-11-09']['claude/new'], 'new usage added');
});

test('nothing to publish is a clear error', async () => {
  const result = await cli(makeHome({ snapshot: false, ledger: false }), 'publish', '--yes');
  assert.equal(result.code, 1);
  assert.match(result.output, /Run `collect` first/);
  assert.deepEqual(github.writes, []);
});

test('render writes every output, with no GitHub access needed', async () => {
  const home = makeHome();
  writeFileSync(join(home, 'snapshot.json'), JSON.stringify(emptySnapshot()));
  const result = await cli(home, 'render');
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /preview\.html/);
});

test('it runs from a folder with a space in its path', async () => {
  const root = join(mkdtempSync(join(tmpdir(), 'omg-cli-')), 'My Projects', 'oh-my-gist');
  mkdirSync(root, { recursive: true });
  cpSync(resolve(import.meta.dirname, '../src'), join(root, 'src'), { recursive: true });
  cpSync(resolve(import.meta.dirname, '../oh-my-gist.config.json'), join(root, 'oh-my-gist.config.json'));
  const env = { ...process.env, OMG_HOME: makeHome(), OMG_OUT: '', OMG_TIMEZONE: 'UTC', OH_MY_GIST_TOKEN: 'test-token', NODE_NO_WARNINGS: '1' };
  await run(process.execPath, [join(root, 'src', 'cli.ts'), 'render'], { env });
  assert.ok(existsSync(join(root, 'out', 'preview.html')), 'output lands inside the install folder');
});

test('conflicting flags and unknown commands fail clearly', async () => {
  assert.match((await cli(makeHome(), 'publish', '--github-only', '--tokens-only')).output, /cannot be combined/);
  assert.match((await cli(makeHome(), 'publish', '--yes', '--update-only')).output, /cannot be combined/);
  assert.match((await cli(makeHome(), 'nonsense')).output, /Unknown command/);
});
