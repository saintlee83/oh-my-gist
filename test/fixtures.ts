import type { Snapshot, TokenLedger } from '../src/types.ts';

export function emptySnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    version: 1,
    generatedAt: '2026-11-09T00:00:00Z',
    login: 'octo',
    memberSince: '2019-05-18T06:24:18Z',
    calendar: [],
    years: [],
    commits: [],
    pulls: [],
    issues: [],
    reviews: [],
    coauthors: { named: [], privatePeople: 0, privateCommits: 0, coauthoredCommits: 0, soloCommits: 0, byKind: { ai: 0, bot: 0, person: 0 } },
    languages: [],
    churn: {},
    totals: { issueComments: 0, discussions: 0, organizations: 0, stars: 0, followers: 0 },
    coverage: {
      reposListed: 0,
      reposWalked: 0,
      reposFailed: 0,
      reposWithCommits: 0,
      churnDone: 0,
      churnPending: 0,
      churnFailed: 0,
      gists: 0,
    },
    ...overrides,
  };
}

/** Deliberately oversized values, to prove cards hold their width at any scale. */
export function extremeSnapshot(): Snapshot {
  const commits = Array.from({ length: 400 }, (_, index) => ({
    oid: `sha${index}`,
    at: new Date(Date.UTC(2026, index % 11, (index % 27) + 1, index % 24)).toISOString(),
    scope: (['personal', 'org', 'external'] as const)[index % 3],
    add: 1000,
    del: 400,
    merge: index % 50 === 0,
    ai: index % 2 ? 'Claude' : null,
    kind: index % 3 ? 'feat' : null,
  }));
  const churn: Snapshot['churn'] = {};
  for (const commit of commits) {
    churn[commit.oid] = {
      TypeScript: [9_999, 8_888],
      'Jupyter Notebook With A Very Long Name': [7_777, 666],
      Python: [100, 5],
      Go: [10, 900],
      Rust: [5, 5],
      Zig: [1, 1],
      'Docs & data': [50, 2],
      Skipped: [500, 500],
    };
  }
  return emptySnapshot({
    calendar: [
      { date: '2026-11-08', count: 999_999 },
      { date: '2026-11-09', count: 12 },
    ],
    years: [{ year: 2026, calendar: 9_999_999, restricted: 123_456 }],
    commits,
    churn,
    pulls: Array.from({ length: 50 }, (_, index) => ({
      createdAt: `2026-0${(index % 9) + 1}-10T10:00:00Z`,
      mergedAt: index % 2 ? `2026-0${(index % 9) + 1}-11T10:00:00Z` : null,
      closedAt: null,
      add: 1,
      del: 1,
      scope: 'org' as const,
    })),
    issues: [{ createdAt: '2026-01-02T03:00:00Z', scope: 'personal' }],
    reviews: [{ at: '2026-03-02T03:00:00Z', prCreatedAt: '2026-03-01T03:00:00Z', scope: 'org' }],
    coauthors: {
      named: [
        { label: 'Claude', kind: 'ai', commits: 1_234_567 },
        { label: '@a-rather-long-github-login-name-indeed', kind: 'person', commits: 99_999 },
        { label: 'dependabot', kind: 'bot', commits: 12 },
      ],
      privatePeople: 42,
      privateCommits: 98_765,
      coauthoredCommits: 1_300_000,
      soloCommits: 12,
      byKind: { ai: 1_234_567, bot: 12, person: 198_764 },
    },
    languages: [
      { name: 'Jupyter Notebook With A Very Long Name', color: null, personal: 9.9e11, org: 9.9e11, external: 0, gist: 1, gistLines: 3 },
      { name: 'TypeScript', color: '#3178c6', personal: 5e9, org: 5e9, external: 1, gist: 1, gistLines: 1 },
      { name: 'Objective-C++', color: null, personal: 1, org: 0, external: 0, gist: 0, gistLines: 0 },
      { name: 'Go', color: null, personal: 1, org: 0, external: 0, gist: 0, gistLines: 0 },
      { name: 'Rust', color: null, personal: 0, org: 1, external: 0, gist: 0, gistLines: 0 },
      { name: 'C', color: null, personal: 0, org: 1, external: 0, gist: 0, gistLines: 0 },
    ],
    totals: { issueComments: 5, discussions: 0, organizations: 12, stars: 3, followers: 37 },
  });
}

export function extremeLedger(): TokenLedger {
  return {
    version: 1,
    days: {
      '2026-11-08': {
        'claude/claude-opus-5-5-with-a-long-suffix': [1, 99_000_000, 999_999_999_999, 5_000_000, 12],
        'codex/gpt-6-astra': [2, 3, 4_000_000_000, 0, 5],
        'codex/an-unpriced-model': [10, 10, 10, 10, 1],
        'codex/fourth-model': [1, 1, 1, 1, 1],
      },
      '2026-11-09': { 'claude/claude-opus-5-5-with-a-long-suffix': [1, 1, 1, 1, 1] },
    },
  };
}
