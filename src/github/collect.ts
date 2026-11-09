import { join } from 'node:path';
import type { Config } from '../config.ts';
import type {
  CommitRow,
  IssueRow,
  LanguageBytes,
  PullRow,
  ReviewRow,
  Scope,
  Snapshot,
  YearRow,
} from '../types.ts';
import { nextDay } from '../util/time.ts';
import { collectChurn, loadChurnCache, saveChurnCache, type ChurnTarget } from './churn.ts';
import { tallyCoauthors, type CoauthorEvent, type GitActor } from './coauthors.ts';
import { aiAgent, commitKind, isCodeLanguage } from './classify.ts';
import { GitHubClient, GitHubError, GraphQLError, RateLimitExhausted, pool } from './client.ts';

const REPO_FIELDS = `
  id nameWithOwner isFork isPrivate
  owner { login __typename }
  languages(first: 100, orderBy: { field: SIZE, direction: DESC }) {
    edges { size node { name color } }
  }
`;

/** Internal only. Names here are needed for API calls and never enter the Snapshot. */
interface Repo {
  id: string;
  nameWithOwner: string;
  isFork: boolean;
  isPrivate: boolean;
  owner: { login: string; __typename: string };
  languages?: { edges: { size: number; node: { name: string; color: string | null } }[] } | null;
}

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

type Log = (message: string) => void;

function scopeOf(owner: { login: string; __typename: string }, login: string, orgs: Set<string>): Scope {
  if (owner.login.toLowerCase() === login.toLowerCase()) return 'personal';
  if (owner.__typename === 'Organization' && orgs.has(owner.login.toLowerCase())) return 'org';
  return 'external';
}

async function collectViewer(client: GitHubClient) {
  const data = await client.graphql<{
    viewer: {
      id: string;
      login: string;
      createdAt: string;
      followers: { totalCount: number };
      issueComments: { totalCount: number };
      repositoryDiscussions: { totalCount: number };
      organizations: { totalCount: number; nodes: { login: string }[] };
      contributionsCollection: { contributionYears: number[] };
    };
  }>(`query {
    viewer {
      id login createdAt
      followers { totalCount }
      issueComments { totalCount }
      repositoryDiscussions { totalCount }
      organizations(first: 100) { totalCount nodes { login } }
      contributionsCollection { contributionYears }
    }
  }`);
  return data.viewer;
}

/**
 * The calendar is the only source that includes everything GitHub counts, so it
 * drives totals and streaks. Its per-type breakdown is not usable: private work
 * lands in `restrictedContributionsCount` even for your own token, which is why
 * commits, PRs and reviews are collected by walking instead.
 */
async function collectYears(client: GitHubClient, years: number[], now: Date) {
  const calendar: { date: string; count: number }[] = [];
  const rows: YearRow[] = [];
  const contributedRepos = new Map<string, Repo>();
  const today = now.toISOString().slice(0, 10);

  await pool(years, 4, async (year) => {
    const data = await client.graphql<{
      viewer: {
        contributionsCollection: {
          restrictedContributionsCount: number;
          contributionCalendar: {
            totalContributions: number;
            weeks: { contributionDays: { date: string; contributionCount: number }[] }[];
          };
          commitContributionsByRepository: { repository: Repo }[];
        };
      };
    }>(
      `query($from: DateTime!, $to: DateTime!) {
        viewer {
          contributionsCollection(from: $from, to: $to) {
            restrictedContributionsCount
            contributionCalendar {
              totalContributions
              weeks { contributionDays { date contributionCount } }
            }
            commitContributionsByRepository(maxRepositories: 100) { repository { ${REPO_FIELDS} } }
          }
        }
      }`,
      { from: `${year}-01-01T00:00:00Z`, to: `${year}-12-31T23:59:59Z` },
    );
    const collection = data.viewer.contributionsCollection;
    rows.push({
      year,
      calendar: collection.contributionCalendar.totalContributions,
      restricted: collection.restrictedContributionsCount,
    });
    for (const week of collection.contributionCalendar.weeks) {
      for (const day of week.contributionDays) {
        if (day.date <= today) calendar.push({ date: day.date, count: day.contributionCount });
      }
    }
    for (const { repository } of collection.commitContributionsByRepository) {
      contributedRepos.set(repository.id, repository);
    }
  });

  calendar.sort((a, b) => a.date.localeCompare(b.date));
  rows.sort((a, b) => b.year - a.year);
  return { calendar, rows, contributedRepos };
}

async function paginate<T>(fetchPage: (after: string | null) => Promise<{ nodes: T[]; pageInfo: PageInfo }>): Promise<T[]> {
  const out: T[] = [];
  let after: string | null = null;
  for (;;) {
    const page: { nodes: T[]; pageInfo: PageInfo } = await fetchPage(after);
    out.push(...page.nodes.filter(Boolean));
    if (!page.pageInfo.hasNextPage) return out;
    after = page.pageInfo.endCursor;
  }
}

async function collectRepos(client: GitHubClient, orgLogins: string[], known: Map<string, Repo>): Promise<Repo[]> {
  const repos = new Map(known);
  const affiliations = '[OWNER, COLLABORATOR, ORGANIZATION_MEMBER]';

  const mine = await paginate<Repo>(async (after) => {
    const data = await client.graphql<{ viewer: { repositories: { nodes: Repo[]; pageInfo: PageInfo } } }>(
      `query($after: String) {
        viewer {
          repositories(first: 100, after: $after, affiliations: ${affiliations}, ownerAffiliations: ${affiliations}) {
            pageInfo { hasNextPage endCursor }
            nodes { ${REPO_FIELDS} }
          }
        }
      }`,
      { after },
    );
    return data.viewer.repositories;
  });
  for (const repo of mine) repos.set(repo.id, repo);

  // Repos reachable only through an org's base permission are not "affiliated".
  await pool(orgLogins, 4, async (login) => {
    const nodes = await paginate<Repo>(async (after) => {
      const data = await client.graphql<{ organization: { repositories: { nodes: Repo[]; pageInfo: PageInfo } } | null }>(
        `query($login: String!, $after: String) {
          organization(login: $login) {
            repositories(first: 100, after: $after) {
              pageInfo { hasNextPage endCursor }
              nodes { ${REPO_FIELDS} }
            }
          }
        }`,
        { login, after },
      );
      return data.organization?.repositories ?? { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
    });
    for (const repo of nodes) repos.set(repo.id, repo);
  });

  return [...repos.values()];
}

interface WalkedCommit {
  oid: string;
  authoredDate: string;
  additions: number;
  deletions: number;
  parents: { totalCount: number };
  messageHeadline: string;
  messageBody: string;
  authors: { nodes: GitActor[] };
}

interface WalkPage {
  total: number;
  mine: number;
  nodes: WalkedCommit[];
  pageInfo: PageInfo;
}

const WALK_QUERY = `query($id: ID!, $author: ID!, $after: String, $first: Int!) {
  node(id: $id) {
    ... on Repository {
      defaultBranchRef {
        target {
          ... on Commit {
            all: history { totalCount }
            history(first: $first, after: $after, author: { id: $author }) {
              totalCount
              pageInfo { hasNextPage endCursor }
              nodes {
                oid authoredDate additions deletions
                parents { totalCount }
                messageHeadline messageBody
                authors(first: 10) { nodes { name email user { login } } }
              }
            }
          }
        }
      }
    }
  }
}`;

/** Commit diffs are computed on demand, so large pages can time out. Retry smaller. */
async function walkPage(client: GitHubClient, repoId: string, author: string, after: string | null): Promise<WalkPage | null> {
  let lastError: unknown;
  for (const first of [100, 25, 10]) {
    try {
      const data = await client.graphql<{
        node: {
          defaultBranchRef: {
            target: {
              all: { totalCount: number };
              history: { totalCount: number; pageInfo: PageInfo; nodes: WalkedCommit[] };
            } | null;
          } | null;
        } | null;
      }>(WALK_QUERY, { id: repoId, author, after, first });
      const target = data.node?.defaultBranchRef?.target;
      if (!target?.history) return null;
      return {
        total: target.all.totalCount,
        mine: target.history.totalCount,
        nodes: target.history.nodes,
        pageInfo: target.history.pageInfo,
      };
    } catch (error) {
      if (error instanceof RateLimitExhausted) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

interface WalkResult {
  commits: CommitRow[];
  churnTargets: ChurnTarget[];
  coauthorEvents: CoauthorEvent[];
  shares: Map<string, { mine: number; total: number }>;
  failed: number;
}

async function walkCommits(
  client: GitHubClient,
  repos: Repo[],
  authorId: string,
  scope: (repo: Repo) => Scope,
  log: Log,
  agents: Set<string>,
): Promise<WalkResult> {
  const result: WalkResult = { commits: [], churnTargets: [], coauthorEvents: [], shares: new Map(), failed: 0 };
  let finished = 0;

  await pool(repos, 6, async (repo) => {
    try {
      let after: string | null = null;
      for (;;) {
        const page: WalkPage | null = await walkPage(client, repo.id, authorId, after);
        if (!page) break;
        result.shares.set(repo.id, { mine: page.mine, total: page.total });
        for (const node of page.nodes) {
          const merge = node.parents.totalCount > 1;
          const agent = node.authors.nodes.slice(1).find((actor) => actor.user && agents.has(actor.user.login.toLowerCase()));
          result.commits.push({
            oid: node.oid,
            at: node.authoredDate,
            scope: scope(repo),
            add: node.additions,
            del: node.deletions,
            merge,
            // Commit messages are reduced to these two labels and then dropped.
            ai: aiAgent(`${node.messageHeadline}\n${node.messageBody}`) ?? agent?.user?.login ?? null,
            kind: commitKind(node.messageHeadline),
          });
          result.churnTargets.push({
            oid: node.oid,
            repo: repo.nameWithOwner,
            add: node.additions,
            del: node.deletions,
            merge,
          });
          result.coauthorEvents.push({ oid: node.oid, isPrivate: repo.isPrivate, actors: node.authors.nodes });
        }
        if (!page.pageInfo.hasNextPage) break;
        after = page.pageInfo.endCursor;
      }
    } catch (error) {
      if (error instanceof RateLimitExhausted) throw error;
      result.failed++;
    }
    finished++;
    if (finished % 50 === 0) log(`commits: ${finished}/${repos.length} repos, ${result.commits.length} commits`);
  });
  return result;
}

interface RepoOwner {
  owner: { login: string; __typename: string };
}

async function collectPulls(client: GitHubClient, scope: (owner: RepoOwner['owner']) => Scope): Promise<PullRow[]> {
  const nodes = await paginate<{
    createdAt: string;
    mergedAt: string | null;
    closedAt: string | null;
    additions: number;
    deletions: number;
    repository: RepoOwner;
  }>(async (after) => {
    const data = await client.graphql<{ viewer: { pullRequests: { nodes: never[]; pageInfo: PageInfo } } }>(
      `query($after: String) {
        viewer {
          pullRequests(first: 100, after: $after, orderBy: { field: CREATED_AT, direction: DESC }) {
            pageInfo { hasNextPage endCursor }
            nodes {
              createdAt mergedAt closedAt additions deletions
              repository { owner { login __typename } }
            }
          }
        }
      }`,
      { after },
    );
    return data.viewer.pullRequests;
  });
  return nodes.map((pull) => ({
    createdAt: pull.createdAt,
    mergedAt: pull.mergedAt,
    closedAt: pull.closedAt,
    add: pull.additions,
    del: pull.deletions,
    scope: scope(pull.repository.owner),
  }));
}

async function collectIssues(client: GitHubClient, scope: (owner: RepoOwner['owner']) => Scope): Promise<IssueRow[]> {
  const nodes = await paginate<{ createdAt: string; repository: RepoOwner }>(async (after) => {
    const data = await client.graphql<{ viewer: { issues: { nodes: never[]; pageInfo: PageInfo } } }>(
      `query($after: String) {
        viewer {
          issues(first: 100, after: $after, orderBy: { field: CREATED_AT, direction: DESC }) {
            pageInfo { hasNextPage endCursor }
            nodes { createdAt repository { owner { login __typename } } }
          }
        }
      }`,
      { after },
    );
    return data.viewer.issues;
  });
  return nodes.map((issue) => ({ createdAt: issue.createdAt, scope: scope(issue.repository.owner) }));
}

interface ReviewedPull {
  createdAt?: string;
  author?: { login: string } | null;
  repository?: RepoOwner;
  reviews?: { nodes: { submittedAt: string | null }[] };
}

const SEARCH_CAP = 1000;

/** GitHub search stops at 1,000 results, so busy windows are split in half until they fit. */
export async function searchReviewedPulls(
  client: GitHubClient,
  login: string,
  from: string,
  to: string,
): Promise<ReviewedPull[]> {
  const query = `is:pr reviewed-by:${login} -author:${login} created:${from}..${to}`;
  const out: ReviewedPull[] = [];
  let after: string | null = null;

  for (;;) {
    const data: {
      search: { issueCount: number; pageInfo: PageInfo; nodes: ReviewedPull[] };
    } = await client.graphql(
      `query($query: String!, $after: String, $login: String!) {
        search(query: $query, type: ISSUE, first: 50, after: $after) {
          issueCount
          pageInfo { hasNextPage endCursor }
          nodes {
            ... on PullRequest {
              createdAt
              author { login }
              repository { owner { login __typename } }
              reviews(first: 10, author: $login) { nodes { submittedAt } }
            }
          }
        }
      }`,
      { query, after, login },
    );

    if (data.search.issueCount > SEARCH_CAP && from < to) {
      const start = new Date(`${from}T00:00:00Z`).getTime();
      const end = new Date(`${to}T00:00:00Z`).getTime();
      const middle = new Date(start + Math.floor((end - start) / 2 / 86_400_000) * 86_400_000).toISOString().slice(0, 10);
      const [older, newer] = await Promise.all([
        searchReviewedPulls(client, login, from, middle),
        searchReviewedPulls(client, login, nextDay(middle), to),
      ]);
      return [...older, ...newer];
    }

    out.push(...data.search.nodes);
    if (!data.search.pageInfo.hasNextPage) return out;
    after = data.search.pageInfo.endCursor;
  }
}

async function collectReviews(
  client: GitHubClient,
  login: string,
  memberSince: string,
  now: Date,
  scope: (owner: RepoOwner['owner']) => Scope,
): Promise<ReviewRow[]> {
  const pulls = await searchReviewedPulls(client, login, memberSince.slice(0, 10), now.toISOString().slice(0, 10));
  const rows: ReviewRow[] = [];
  for (const pull of pulls) {
    const times = (pull.reviews?.nodes ?? [])
      .map((review) => review.submittedAt)
      .filter((at): at is string => Boolean(at))
      .sort();
    if (!pull.createdAt || !pull.repository || times.length === 0) continue;
    rows.push({ at: times[0], prCreatedAt: pull.createdAt, scope: scope(pull.repository.owner) });
  }
  return rows;
}

interface GistNode {
  isFork: boolean;
  files:
    | { name: string; size: number; text?: string | null; language: { name: string; color: string | null } | null }[]
    | null;
}

export function countLines(text: string | null | undefined): number {
  if (!text) return 0;
  const breaks = text.split('\n').length - 1;
  return text.endsWith('\n') ? breaks : breaks + 1;
}

async function collectGistLanguages(client: GitHubClient) {
  const gists = await paginate<GistNode>(async (after) => {
    const data = await client.graphql<{ viewer: { gists: { nodes: GistNode[]; pageInfo: PageInfo } } }>(
      `query($after: String) {
        viewer {
          gists(first: 30, after: $after, privacy: ALL) {
            pageInfo { hasNextPage endCursor }
            nodes { isFork files(limit: 300) { name size text language { name color } } }
          }
        }
      }`,
      { after },
    );
    return data.viewer.gists;
  });
  // Skip this tool's own output so the profile does not count itself.
  return gists.filter((gist) => !gist.isFork && !gist.files?.some((file) => file.name.startsWith('oh-my-gist')));
}

/**
 * Bytes per language, credited by your share of each repo's commits. Raw bytes
 * would let a monorepo you touched once outweigh everything you actually wrote.
 * Your own non-fork repos count fully when no commit matched your account, which
 * usually means they were committed under an unlinked email.
 */
export function aggregateLanguages(
  repos: Repo[],
  shares: Map<string, { mine: number; total: number }>,
  gists: GistNode[],
  scope: (repo: Repo) => Scope,
  excluded: string[],
): LanguageBytes[] {
  const skip = new Set(excluded.map((name) => name.toLowerCase()));
  const totals = new Map<string, LanguageBytes>();
  const row = (name: string, color: string | null) => {
    let found = totals.get(name);
    if (!found) {
      found = { name, color, personal: 0, org: 0, external: 0, gist: 0, gistLines: 0 };
      totals.set(name, found);
    }
    return found;
  };

  for (const repo of repos) {
    const where = scope(repo);
    const share = shares.get(repo.id);
    const fraction = share && share.total > 0 ? share.mine / share.total : 0;
    const weight = fraction > 0 ? fraction : where === 'personal' && !repo.isFork ? 1 : 0;
    if (weight === 0) continue;
    for (const edge of repo.languages?.edges ?? []) {
      if (skip.has(edge.node.name.toLowerCase())) continue;
      row(edge.node.name, edge.node.color)[where] += edge.size * weight;
    }
  }

  for (const gist of gists) {
    for (const file of gist.files ?? []) {
      if (!file.language || !isCodeLanguage(file.language.name)) continue;
      if (skip.has(file.language.name.toLowerCase())) continue;
      const target = row(file.language.name, file.language.color);
      target.gist += file.size;
      // File text is only measured here; it is never kept.
      target.gistLines += countLines(file.text);
    }
  }

  const sum = (item: LanguageBytes) => item.personal + item.org + item.external + item.gist;
  return [...totals.values()].filter((item) => sum(item) > 0).sort((a, b) => sum(b) - sum(a));
}

export async function collectGitHub(client: GitHubClient, config: Config, log: Log, now = new Date()): Promise<Snapshot> {
  log('profile and contribution calendar');
  const viewer = await collectViewer(client);
  const login = viewer.login;
  const orgLogins = viewer.organizations.nodes.map((org) => org.login);
  const orgSet = new Set(orgLogins.map((name) => name.toLowerCase()));
  const scopeOfOwner = (owner: RepoOwner['owner']) => scopeOf(owner, login, orgSet);
  const scopeOfRepo = (repo: Repo) => scopeOfOwner(repo.owner);

  const { calendar, rows: years, contributedRepos } = await collectYears(
    client,
    viewer.contributionsCollection.contributionYears,
    now,
  );

  log(`repositories across ${orgLogins.length} organizations`);
  const repos = await collectRepos(client, orgLogins, contributedRepos);

  log(`walking commits in ${repos.length} repositories`);
  const agents = new Set(config.agentCoauthors.map((name) => name.toLowerCase()));
  const walk = await walkCommits(client, repos, viewer.id, scopeOfRepo, log, agents);
  const seen = new Set<string>();
  const commits = walk.commits.filter((commit) => {
    // Forks share history with their parent, so one commit can be reached twice.
    if (seen.has(commit.oid)) return false;
    seen.add(commit.oid);
    return true;
  });
  const churnSeen = new Set<string>();
  const churnTargets = walk.churnTargets.filter((target) => {
    if (churnSeen.has(target.oid)) return false;
    churnSeen.add(target.oid);
    return true;
  });

  log('pull requests, issues and reviews');
  const [pulls, issues, reviews] = await Promise.all([
    collectPulls(client, scopeOfOwner),
    collectIssues(client, scopeOfOwner),
    collectReviews(client, login, viewer.createdAt, now, scopeOfOwner),
  ]);

  log('gist languages');
  const gists = await collectGistLanguages(client);
  const languages = aggregateLanguages(repos, walk.shares, gists, scopeOfRepo, config.excludeLanguages);

  const cachePath = join(config.home, 'churn-cache.json');
  const cache = loadChurnCache(cachePath);
  const churnResult = await collectChurn(client, churnTargets, cache, {
    maxRequests: config.churn.maxRequestsPerRun,
    maxFileLines: config.churn.maxFileLines,
    concurrency: config.churn.concurrency,
    onCheckpoint: () => saveChurnCache(cachePath, cache),
    log,
  });
  if (churnResult.stoppedByLimit) {
    log(`churn: ${churnResult.pending} commits still pending; the next run continues from the cache`);
  }

  const churn: Snapshot['churn'] = {};
  for (const commit of commits) {
    const entry = cache.commits[commit.oid];
    if (entry) churn[commit.oid] = entry;
  }

  const stars = await client
    .graphql<{ viewer: { repositories: { totalCount: number; nodes: { stargazerCount: number }[]; pageInfo: PageInfo } } }>(
      `query {
        viewer {
          repositories(first: 100, ownerAffiliations: [OWNER], isFork: false, privacy: PUBLIC, orderBy: { field: STARGAZERS, direction: DESC }) {
            totalCount
            pageInfo { hasNextPage endCursor }
            nodes { stargazerCount }
          }
        }
      }`,
    )
    .then((data) => data.viewer.repositories.nodes.reduce((sum, repo) => sum + repo.stargazerCount, 0))
    .catch((error: unknown) => {
      if (error instanceof GraphQLError || error instanceof GitHubError) return 0;
      throw error;
    });

  return {
    version: 1,
    generatedAt: now.toISOString(),
    login,
    memberSince: viewer.createdAt,
    calendar,
    years,
    commits,
    pulls,
    issues,
    reviews,
    coauthors: tallyCoauthors(walk.coauthorEvents, login, commits.filter((commit) => !commit.merge).length, config.namedCoauthors, config.agentCoauthors),
    languages,
    churn,
    totals: {
      issueComments: viewer.issueComments.totalCount,
      discussions: viewer.repositoryDiscussions.totalCount,
      organizations: viewer.organizations.totalCount,
      stars,
      followers: viewer.followers.totalCount,
    },
    coverage: {
      reposListed: repos.length,
      reposWalked: repos.length - walk.failed,
      reposFailed: walk.failed,
      reposWithCommits: [...walk.shares.values()].filter((share) => share.mine > 0).length,
      churnDone: churnResult.done,
      churnPending: churnResult.pending,
      churnFailed: churnResult.failed,
      gists: gists.length,
    },
  };
}
