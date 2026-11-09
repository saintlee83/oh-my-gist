import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Config } from '../src/config.ts';
import { collectChurn, type ChurnCache, type ChurnTarget } from '../src/github/churn.ts';
import { GitHubClient, GraphQLError, MissingScopes, RateLimitExhausted, redactQuoted } from '../src/github/client.ts';
import { aiLabel, tallyCoauthors, type CoauthorEvent } from '../src/github/coauthors.ts';
import { aggregateLanguages, collectGitHub, countLines } from '../src/github/collect.ts';
import {
  assertCreationAllowed,
  ConfirmationRequired,
  fetchRemoteLedger,
  publishSpec,
  type GistSpec,
  type PublishOptions,
} from '../src/github/gists.ts';
import { computeMetrics } from '../src/metrics.ts';
import { buildCards, cardContent } from '../src/render/cards.ts';
import { renderHub } from '../src/render/report.ts';
import { renderDashboard } from '../src/render/svg.ts';

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
}

function clientWith(handler: Handler): GitHubClient {
  return new GitHubClient('token', {
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => handler(String(input), init ?? {})) as typeof fetch,
    sleep: async () => {},
  });
}

test('server errors are retried, then succeed', async () => {
  let calls = 0;
  const client = clientWith(() => (++calls < 3 ? new Response('bad gateway', { status: 502 }) : json({ ok: true })));
  assert.deepEqual(await client.rest('/x'), { ok: true });
  assert.equal(calls, 3);
});

test('secondary rate limits wait and retry', async () => {
  let calls = 0;
  const client = clientWith(() =>
    ++calls === 1 ? new Response('slow down', { status: 403, headers: { 'retry-after': '1' } }) : json({ ok: true }),
  );
  assert.deepEqual(await client.rest('/x'), { ok: true });
});

test('an exhausted primary rate limit stops immediately', async () => {
  let calls = 0;
  const client = clientWith(() => {
    calls++;
    return new Response('limit', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000' } });
  });
  await assert.rejects(client.rest('/x'), RateLimitExhausted);
  assert.equal(calls, 1);
});

test('GraphQL field errors surface with partial data', async () => {
  const client = clientWith(() => json({ data: { a: 1 }, errors: [{ message: 'forbidden', type: 'FORBIDDEN' }] }));
  await assert.rejects(client.graphql('query { a }'), (error: unknown) => {
    assert.ok(error instanceof GraphQLError);
    assert.deepEqual(error.partial, { a: 1 });
    return true;
  });
});

function clientWithScopes(token: string, scopes: string | null): GitHubClient {
  const headers: Record<string, string> = scopes === null ? {} : { 'x-oauth-scopes': scopes };
  return new GitHubClient(token, {
    fetchImpl: (async () => new Response('{}', { status: 200, headers })) as typeof fetch,
    sleep: async () => {},
  });
}

test('required scopes are checked for classic tokens', async () => {
  const required = ['repo', 'read:org', 'gist'];
  const check = async (token: string, scopes: string | null) => {
    const client = clientWithScopes(token, scopes);
    await client.rest('/x');
    return client.missingScopes(required);
  };
  assert.deepEqual(await check('ghp_x', 'gist, read:org, repo, workflow'), []);
  assert.deepEqual(await check('gho_x', 'gist'), ['repo', 'read:org']);
  assert.deepEqual(await check('ghp_x', ''), required, 'a classic token with no scopes lacks them all');
  assert.deepEqual(await check('ghp_x', 'repo, gist, admin:org'), [], 'admin:org includes read:org');
  assert.deepEqual(await check('github_pat_x', ''), [], 'fine-grained tokens cannot be checked');
  assert.deepEqual(await check('ghp_x', null), [], 'no header means nothing to check');
});

test('quoted names are removed from errors bound for public logs', () => {
  assert.equal(
    redactQuoted(`GitHub GraphQL: Could not resolve to an Organization with the login of 'stealth-org'.`),
    `GitHub GraphQL: Could not resolve to an Organization with the login of '[redacted]'.`,
  );
  assert.equal(redactQuoted('GitHub 404: Not Found'), 'GitHub 404: Not Found');
});

test('a token that cannot see private work stops collection before it starts', async () => {
  const queries: string[] = [];
  const client = new GitHubClient('ghp_underscoped', {
    fetchImpl: (async (_: unknown, init?: RequestInit) => {
      queries.push(String(init?.body));
      return new Response(
        JSON.stringify({
          data: {
            viewer: {
              id: 'U1',
              login: 'octo',
              createdAt: '2020-01-01T00:00:00Z',
              followers: { totalCount: 0 },
              issueComments: { totalCount: 0 },
              repositoryDiscussions: { totalCount: 0 },
              organizations: { totalCount: 0, nodes: [] },
              contributionsCollection: { contributionYears: [2026] },
            },
          },
        }),
        { status: 200, headers: { 'x-oauth-scopes': 'gist' } },
      );
    }) as typeof fetch,
    sleep: async () => {},
  });
  const home = mkdtempSync(join(tmpdir(), 'omg-test-'));
  const config: Config = {
    timezone: 'UTC',
    public: true,
    home,
    outDir: join(home, 'out'),
    excludeLanguages: [],
    namedCoauthors: [],
    agentCoauthors: [],
    churn: { maxRequestsPerRun: 10, maxFileLines: 5000, maxCommitLines: 20000, concurrency: 1 },
  };
  await assert.rejects(collectGitHub(client, config, () => {}), (error: unknown) => {
    assert.ok(error instanceof MissingScopes);
    assert.deepEqual(error.missing, ['repo', 'read:org']);
    return true;
  });
  assert.equal(queries.length, 1, 'stopped right after reading the profile');
});

function targets(count: number): ChurnTarget[] {
  return Array.from({ length: count }, (_, index) => ({ oid: `sha${index}`, repo: 'o/r', add: 1, del: 1, merge: false }));
}

const churnOptions = { maxRequests: 100, maxFileLines: 5000, concurrency: 2 };
const commitResponse = () => json({ files: [{ filename: 'a.ts', additions: 1, deletions: 1 }] }, { headers: { 'x-ratelimit-remaining': '4000' } });

test('churn fetches each commit once across runs', async () => {
  let calls = 0;
  const client = clientWith(() => {
    calls++;
    return commitResponse();
  });
  const cache: ChurnCache = { version: 1, commits: {} };
  const first = await collectChurn(client, targets(3), cache, churnOptions);
  assert.equal(first.done, 3);
  assert.equal(first.pending, 0);
  assert.equal(calls, 3);
  await collectChurn(client, targets(3), cache, churnOptions);
  assert.equal(calls, 3, 'second run should be served from the cache');
});

test('merge and empty commits cost no requests', async () => {
  let calls = 0;
  const client = clientWith(() => {
    calls++;
    return commitResponse();
  });
  const cache: ChurnCache = { version: 1, commits: {} };
  const result = await collectChurn(
    client,
    [
      { oid: 'merge', repo: 'o/r', add: 5, del: 5, merge: true },
      { oid: 'empty', repo: 'o/r', add: 0, del: 0, merge: false },
    ],
    cache,
    churnOptions,
  );
  assert.equal(calls, 0);
  assert.equal(result.done, 2);
});

test('churn honors its budget and resumes on the next run', async () => {
  const client = clientWith(commitResponse);
  const cache: ChurnCache = { version: 1, commits: {} };
  const first = await collectChurn(client, targets(10), cache, { ...churnOptions, maxRequests: 4, concurrency: 1 });
  assert.equal(first.done, 4);
  assert.equal(first.pending, 6);
  assert.equal(first.stoppedByLimit, true);
  const second = await collectChurn(client, targets(10), cache, churnOptions);
  assert.equal(second.done, 10);
  assert.equal(second.stoppedByLimit, false);
});

test('churn stops at the reserve to leave budget for publishing', async () => {
  let calls = 0;
  const client = clientWith(() => {
    calls++;
    return json({ files: [] }, { headers: { 'x-ratelimit-remaining': String(202 - calls) } });
  });
  const cache: ChurnCache = { version: 1, commits: {} };
  await collectChurn(client, targets(50), cache, { ...churnOptions, concurrency: 1, reserve: 200 });
  assert.equal(calls, 2);
});

test('a commit that fails is retried later without losing the rest', async () => {
  let failing = true;
  const client = clientWith((url) => {
    if (failing && url.includes('sha1')) return new Response('{"message":"gone"}', { status: 404 });
    return commitResponse();
  });
  const cache: ChurnCache = { version: 1, commits: {} };
  const first = await collectChurn(client, targets(3), cache, churnOptions);
  assert.equal(first.failed, 1);
  assert.equal(first.done, 2);
  assert.equal(first.pending, 1);
  assert.equal(first.stoppedByLimit, false);
  failing = false;
  assert.equal((await collectChurn(client, targets(3), cache, churnOptions)).pending, 0);
});

function actor(name: string, email: string, login: string | null = null) {
  return { name, email, user: login ? { login } : null };
}

const me = actor('Me', 'me@example.com', 'octo');

test('co-authors: AI and bots are named and ranked', () => {
  const events: CoauthorEvent[] = [
    { oid: '1', isPrivate: true, actors: [me, actor('Claude Opus 5.5', 'noreply@anthropic.com')] },
    { oid: '2', isPrivate: true, actors: [me, actor('Claude Sonnet 5.5', 'noreply@anthropic.com')] },
    { oid: '3', isPrivate: false, actors: [me, actor('dependabot[bot]', '49699333+dependabot[bot]@users.noreply.github.com', 'dependabot')] },
    { oid: '4', isPrivate: false, actors: [me] },
  ];
  const summary = tallyCoauthors(events, 'octo', 4);
  assert.deepEqual(summary.named, [
    { label: 'Claude Opus 5.5', kind: 'ai', commits: 1 },
    { label: 'Claude Sonnet 5.5', kind: 'ai', commits: 1 },
    { label: 'dependabot', kind: 'bot', commits: 1 },
  ]);
  assert.equal(summary.coauthoredCommits, 3);
  assert.equal(summary.soloCommits, 1);
  assert.deepEqual(summary.byKind, { ai: 2, bot: 1, person: 0 });
});

test('co-authors: one model keeps one row across trailer spellings', () => {
  assert.equal(aiLabel('Claude Opus 5 (1M context)', 'Claude'), 'Claude Opus 5');
  assert.equal(aiLabel('Claude', 'Claude'), 'Claude');
  assert.equal(aiLabel('GitHub Copilot', 'Copilot'), 'Copilot');
  const events: CoauthorEvent[] = [
    { oid: '1', isPrivate: true, actors: [me, actor('Claude Opus 5 (1M context)', 'noreply@anthropic.com', 'claude')] },
    { oid: '2', isPrivate: true, actors: [me, actor('Claude Opus 5', 'noreply@anthropic.com', 'claude')] },
  ];
  assert.deepEqual(tallyCoauthors(events, 'octo', 2).named, [{ label: 'Claude Opus 5', kind: 'ai', commits: 2 }]);
});

test('co-authors: your own agent account is named and counted as AI', () => {
  const agent = actor('Team Agent', 'agent@corp.example', 'team-agent');
  const person = actor('Other', 'other@corp.example', 'other-person');
  const events: CoauthorEvent[] = [
    { oid: '1', isPrivate: true, actors: [me, agent] },
    { oid: '2', isPrivate: true, actors: [me, agent, person] },
  ];
  const summary = tallyCoauthors(events, 'octo', 2, [], ['TEAM-AGENT']);
  assert.deepEqual(summary.named, [{ label: '@team-agent', kind: 'ai', commits: 2 }]);
  assert.deepEqual(summary.byKind, { ai: 2, bot: 0, person: 1 });
  assert.equal(summary.privatePeople, 1);
  assert.ok(!JSON.stringify(summary).includes('other-person'));
});

test('co-authors: namedCoauthors opts a private collaborator in', () => {
  const agent = actor('Team Agent', 'agent@corp.example', 'team-agent');
  const other = actor('Other', 'other@corp.example', 'other-person');
  const events: CoauthorEvent[] = [
    { oid: '1', isPrivate: true, actors: [me, agent] },
    { oid: '2', isPrivate: true, actors: [me, agent] },
    { oid: '3', isPrivate: true, actors: [me, other] },
  ];
  const summary = tallyCoauthors(events, 'octo', 3, ['TEAM-AGENT']);
  assert.deepEqual(summary.named, [{ label: '@team-agent', kind: 'person', commits: 2 }]);
  assert.equal(summary.privatePeople, 1);
  assert.equal(summary.privateCommits, 1);
  assert.equal(summary.byKind.person, 3);
  assert.ok(!JSON.stringify(summary).includes('other-person'));
});

test('co-authors: a person from a private repo is never named', () => {
  const events: CoauthorEvent[] = [
    { oid: '1', isPrivate: true, actors: [me, actor('Secret Teammate', 'secret@corp.example', 'secret-teammate')] },
    { oid: '2', isPrivate: true, actors: [me, actor('Secret Teammate', 'secret@corp.example', 'secret-teammate')] },
    { oid: '3', isPrivate: true, actors: [me, actor('No Account', 'unlinked@corp.example')] },
  ];
  const summary = tallyCoauthors(events, 'octo', 3);
  assert.deepEqual(summary.named, []);
  assert.equal(summary.privatePeople, 2);
  assert.equal(summary.privateCommits, 3);
  const output = JSON.stringify(summary);
  for (const secret of ['Secret Teammate', 'secret-teammate', 'corp.example', 'No Account', 'unlinked']) {
    assert.ok(!output.includes(secret), secret);
  }
});

test('co-authors: a public collaborator shows public commits only', () => {
  const pal = actor('Pal', 'pal@example.com', 'pal');
  const events: CoauthorEvent[] = [
    { oid: '1', isPrivate: false, actors: [me, pal] },
    { oid: '2', isPrivate: true, actors: [me, pal] },
    { oid: '3', isPrivate: true, actors: [me, pal] },
  ];
  const summary = tallyCoauthors(events, 'octo', 3);
  assert.deepEqual(summary.named, [{ label: '@pal', kind: 'person', commits: 1 }]);
  assert.equal(summary.privateCommits, 2);
});

test('co-authors: a public trailer with no GitHub account stays anonymous', () => {
  const events: CoauthorEvent[] = [{ oid: '1', isPrivate: false, actors: [me, actor('Someone', 'someone@example.com')] }];
  const summary = tallyCoauthors(events, 'octo', 1);
  assert.deepEqual(summary.named, []);
  assert.equal(summary.privatePeople, 1);
  assert.ok(!JSON.stringify(summary).includes('someone@example.com'));
});

test('co-authors: crediting yourself or repeating a co-author counts once', () => {
  const pal = actor('Pal', 'pal@example.com', 'pal');
  const events: CoauthorEvent[] = [
    { oid: '1', isPrivate: false, actors: [me, actor('Me Again', 'second@example.com', 'OCTO'), actor('Me', 'me@example.com')] },
    { oid: '2', isPrivate: false, actors: [me, pal, pal] },
    { oid: '2', isPrivate: false, actors: [me, pal] }, // Same commit reached through a fork.
  ];
  const summary = tallyCoauthors(events, 'octo', 2);
  assert.deepEqual(summary.named, [{ label: '@pal', kind: 'person', commits: 1 }]);
  assert.equal(summary.coauthoredCommits, 1);
  assert.equal(summary.soloCommits, 1);
});

const repo = (id: string, owner: string, ownerType: string, isFork: boolean, bytes: number) => ({
  id,
  nameWithOwner: `${owner}/${id}`,
  isFork,
  isPrivate: true,
  owner: { login: owner, __typename: ownerType },
  languages: { edges: [{ size: bytes, node: { name: 'Go', color: '#00ADD8' } }] },
});

test('language bytes are weighted by commit share', () => {
  const repos = [repo('mono', 'corp', 'Organization', false, 1_000_000)];
  const shares = new Map([['mono', { mine: 1, total: 100 }]]);
  const [row] = aggregateLanguages(repos, shares, [], () => 'org', []);
  assert.equal(row.org, 10_000);
});

test('own repos with unlinked commits still count; untouched forks and org repos do not', () => {
  const repos = [
    repo('mine', 'octo', 'User', false, 500),
    repo('fork', 'octo', 'User', true, 900),
    repo('corp', 'corp', 'Organization', false, 900),
  ];
  const shares = new Map([
    ['mine', { mine: 0, total: 5 }],
    ['fork', { mine: 0, total: 5 }],
    ['corp', { mine: 0, total: 5 }],
  ]);
  const scope = (item: { owner: { login: string } }) => (item.owner.login === 'octo' ? 'personal' : 'org') as 'personal' | 'org';
  const rows = aggregateLanguages(repos, shares, [], scope, []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].personal, 500);
  assert.equal(rows[0].org, 0);
});

test('gist languages count code but not prose, and exclusions apply', () => {
  const gists = [
    {
      isFork: false,
      files: [
        { name: 'a.py', size: 100, text: 'one\ntwo\nthree\n', language: { name: 'Python', color: null } },
        { name: 'b.md', size: 999, language: { name: 'Markdown', color: null } },
        { name: 'c.rb', size: 100, language: { name: 'Ruby', color: null } },
      ],
    },
  ];
  const rows = aggregateLanguages([], new Map(), gists, () => 'personal', ['ruby']);
  assert.deepEqual(rows.map((row) => row.name), ['Python']);
  assert.equal(rows[0].gist, 100);
  assert.equal(rows[0].gistLines, 3);
  assert.ok(!JSON.stringify(rows).includes('three'), 'gist text is measured, not kept');
});

test('countLines handles a trailing newline and empty input', () => {
  assert.equal(countLines('a\nb\n'), 2);
  assert.equal(countLines('a\nb'), 2);
  assert.equal(countLines(''), 0);
  assert.equal(countLines(null), 0);
});

/** The end-to-end privacy guarantee: no private name reaches anything publishable. */
test('private names never reach the snapshot or any published output', async () => {
  const PRIVATE_REPO = 'acme-secret-project';
  const PRIVATE_ORG = 'stealth-org';
  const PRIVATE_PERSON = 'hidden-colleague';
  const PRIVATE_EMAIL = 'hidden@stealth.example';
  const COMMIT_TEXT = 'confidential-launch-plan';
  const PRIVATE_FILE = 'src/acme-internal-billing.ts';

  const secretRepo = {
    id: 'R1',
    nameWithOwner: `${PRIVATE_ORG}/${PRIVATE_REPO}`,
    isFork: false,
    isPrivate: true,
    owner: { login: PRIVATE_ORG, __typename: 'Organization' },
    languages: { edges: [{ size: 1000, node: { name: 'TypeScript', color: '#3178c6' } }] },
  };
  const emptyPage = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };

  const handler: Handler = async (url, init) => {
    if (url.includes(`/repos/${PRIVATE_ORG}/${PRIVATE_REPO}/commits/`)) {
      return json({ files: [{ filename: PRIVATE_FILE, additions: 10, deletions: 2 }] });
    }
    const { query } = JSON.parse(String(init.body)) as { query: string };
    if (query.includes('contributionYears')) {
      return json({
        data: {
          viewer: {
            id: 'U1',
            login: 'octo',
            createdAt: '2020-01-01T00:00:00Z',
            followers: { totalCount: 1 },
            issueComments: { totalCount: 1 },
            repositoryDiscussions: { totalCount: 0 },
            organizations: { totalCount: 1, nodes: [{ login: PRIVATE_ORG }] },
            contributionsCollection: { contributionYears: [2026] },
          },
        },
      });
    }
    if (query.includes('contributionCalendar')) {
      return json({
        data: {
          viewer: {
            contributionsCollection: {
              restrictedContributionsCount: 5,
              contributionCalendar: {
                totalContributions: 6,
                weeks: [{ contributionDays: [{ date: '2026-05-05', contributionCount: 6 }] }],
              },
              commitContributionsByRepository: [{ repository: secretRepo }],
            },
          },
        },
      });
    }
    if (query.includes('history(first: $first')) {
      return json({
        data: {
          node: {
            defaultBranchRef: {
              target: {
                all: { totalCount: 2 },
                history: {
                  totalCount: 1,
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      oid: 'abc123',
                      authoredDate: '2026-05-05T01:00:00Z',
                      additions: 12,
                      deletions: 2,
                      parents: { totalCount: 1 },
                      messageHeadline: `feat: ${COMMIT_TEXT}`,
                      messageBody: `Co-authored-by: ${PRIVATE_PERSON} <${PRIVATE_EMAIL}>`,
                      authors: {
                        nodes: [
                          { name: 'Me', email: 'me@example.com', user: { login: 'octo' } },
                          { name: PRIVATE_PERSON, email: PRIVATE_EMAIL, user: { login: PRIVATE_PERSON } },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      });
    }
    if (query.includes('organization(login')) return json({ data: { organization: { repositories: { nodes: [secretRepo], pageInfo: emptyPage.pageInfo } } } });
    if (query.includes('pullRequests(')) {
      return json({
        data: {
          viewer: {
            pullRequests: {
              ...emptyPage,
              nodes: [{ createdAt: '2026-05-05T01:00:00Z', mergedAt: null, closedAt: null, additions: 1, deletions: 1, repository: { owner: secretRepo.owner } }],
            },
          },
        },
      });
    }
    if (query.includes('issues(')) return json({ data: { viewer: { issues: emptyPage } } });
    if (query.includes('search(')) return json({ data: { search: { issueCount: 0, ...emptyPage } } });
    if (query.includes('gists(')) return json({ data: { viewer: { gists: emptyPage } } });
    if (query.includes('STARGAZERS')) return json({ data: { viewer: { repositories: { totalCount: 0, ...emptyPage } } } });
    if (query.includes('repositories(first: 100')) return json({ data: { viewer: { repositories: { nodes: [secretRepo], pageInfo: emptyPage.pageInfo } } } });
    throw new Error(`Unexpected query: ${query.slice(0, 80)}`);
  };

  const home = mkdtempSync(join(tmpdir(), 'omg-test-'));
  const config: Config = {
    timezone: 'Asia/Seoul',
    public: true,
    home,
    outDir: join(home, 'out'),
    excludeLanguages: [],
    namedCoauthors: [],
    agentCoauthors: [],
    churn: { maxRequestsPerRun: 10, maxFileLines: 5000, maxCommitLines: 20000, concurrency: 1 },
  };
  const now = new Date('2026-11-09T00:00:00Z');
  const snapshot = await collectGitHub(clientWith(handler), config, () => {}, now);

  assert.equal(snapshot.commits.length, 1);
  assert.equal(snapshot.commits[0].scope, 'org');
  assert.equal(snapshot.commits[0].kind, 'feat');
  assert.deepEqual(snapshot.churn.abc123.TypeScript, [10, 2]);
  assert.equal(snapshot.coauthors.privatePeople, 1);
  // A one-in-two commit share credits half the repo's bytes.
  assert.equal(snapshot.languages[0].org, 500);

  const metrics = computeMetrics(snapshot, null, {}, config.timezone, now);
  const cards = buildCards(metrics);
  const published = [
    JSON.stringify(snapshot),
    ...cards.map((card) => `${card.title}\n${cardContent(card, metrics.generatedDate)}`),
    renderHub('octo', cards, metrics.generatedDate, { cards: {}, dashboardUrl: null }),
    renderDashboard(metrics),
  ].join('\n');

  for (const secret of [PRIVATE_REPO, PRIVATE_ORG, PRIVATE_PERSON, PRIVATE_EMAIL, COMMIT_TEXT, 'acme-internal']) {
    assert.ok(!published.includes(secret), `leaked: ${secret}`);
  }
});

const spec: GistSpec = {
  key: 'languages',
  description: 'Top languages',
  primaryFile: 'oh-my-gist-languages.txt',
  files: { 'oh-my-gist-languages.txt': 'hello\n' },
};
const existing = { id: 'g1', html_url: 'https://gist.github.com/g1', files: { 'oh-my-gist-languages.txt': { filename: 'oh-my-gist-languages.txt' } } };
const write: PublishOptions = { public: true, confirmed: true, dryRun: false };

test('publish creates a gist that does not exist', async () => {
  const calls: { method?: string; url: string; body: any }[] = [];
  const client = clientWith((url, init) => {
    calls.push({ method: init.method, url, body: JSON.parse(String(init.body)) });
    return json({ id: 'new', html_url: 'https://gist.github.com/new', files: {} });
  });
  const result = await publishSpec(client, spec, null, write);
  assert.equal(result.action, 'created');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].body.public, true);
  assert.equal(calls[0].body.files['oh-my-gist-languages.txt'].content, 'hello\n');
});

test('publish skips the write when nothing changed', async () => {
  const methods: (string | undefined)[] = [];
  const client = clientWith((_, init) => {
    methods.push(init.method);
    return json({ ...existing, description: spec.description, files: { 'oh-my-gist-languages.txt': { filename: 'x', content: 'hello\n' } } });
  });
  const result = await publishSpec(client, spec, existing, write);
  assert.equal(result.action, 'unchanged');
  assert.deepEqual(methods, [undefined], 'only the read, no PATCH');
});

test('publish updates when the content differs', async () => {
  const methods: (string | undefined)[] = [];
  const client = clientWith((_, init) => {
    methods.push(init.method);
    return json({ ...existing, description: spec.description, files: { 'oh-my-gist-languages.txt': { filename: 'x', content: 'old\n' } } });
  });
  assert.equal((await publishSpec(client, spec, existing, write)).action, 'updated');
  assert.deepEqual(methods, [undefined, 'PATCH']);
});

test('dry run never writes', async () => {
  const methods: (string | undefined)[] = [];
  const client = clientWith((_, init) => {
    methods.push(init.method);
    return json({ ...existing, description: 'old', files: {} });
  });
  const dry = { ...write, dryRun: true };
  assert.equal((await publishSpec(client, spec, existing, dry)).action, 'would-update');
  assert.equal((await publishSpec(client, spec, null, dry)).action, 'would-create');
  assert.ok(methods.every((method) => method === undefined));
});

test('creating public gists requires explicit confirmation before any write', () => {
  const unconfirmed = { ...write, confirmed: false };
  assert.throws(() => assertCreationAllowed([spec], [], unconfirmed), ConfirmationRequired);
  assert.doesNotThrow(() => assertCreationAllowed([spec], [existing], unconfirmed), 'updates need no confirmation');
  assert.doesNotThrow(() => assertCreationAllowed([spec], [], write));
  assert.doesNotThrow(() => assertCreationAllowed([spec], [], { ...unconfirmed, dryRun: true }));
});

test('a published ledger can be read back, and a broken one is ignored', async () => {
  const ledger = { version: 1, days: { '2026-11-09': { 'claude/m': [1, 2, 3, 4, 5] } } };
  const gist = { id: 'g', html_url: 'u', files: { 'tokens-ledger.json': { filename: 'tokens-ledger.json' } } };
  const good = clientWith(() => json({ ...gist, files: { 'tokens-ledger.json': { filename: 'x', content: JSON.stringify(ledger) } } }));
  assert.deepEqual(await fetchRemoteLedger(good, [gist], 'tokens-ledger.json'), ledger);
  const bad = clientWith(() => json({ ...gist, files: { 'tokens-ledger.json': { filename: 'x', content: 'not json' } } }));
  assert.equal(await fetchRemoteLedger(bad, [gist], 'tokens-ledger.json'), null);
  assert.equal(await fetchRemoteLedger(good, [], 'tokens-ledger.json'), null);
});
