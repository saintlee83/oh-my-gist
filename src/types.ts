/**
 * Privacy boundary: a Snapshot is what collectors hand to the render layer.
 * It holds aggregates and opaque commit hashes only. Repository, organization
 * and file names must never appear here, so nothing downstream can leak them.
 */

export type Scope = 'personal' | 'org' | 'external';

export interface CommitRow {
  oid: string;
  at: string;
  scope: Scope;
  add: number;
  del: number;
  merge: boolean;
  /** AI assistant credited in the commit message, if any. */
  ai: string | null;
  /** Conventional-commit type (feat, fix, ...), if any. */
  kind: string | null;
}

export interface PullRow {
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  add: number;
  del: number;
  scope: Scope;
}

export interface IssueRow {
  createdAt: string;
  scope: Scope;
}

export interface ReviewRow {
  /** Submission time of the viewer's first review on the PR. */
  at: string;
  prCreatedAt: string;
  scope: Scope;
}

/** Bytes credited per source. Lines written come from churn, except for gists. */
export interface LanguageBytes {
  name: string;
  color: string | null;
  personal: number;
  org: number;
  external: number;
  gist: number;
  gistLines: number;
}

/** Lines changed per language in one commit: language -> [added, deleted]. */
export type CommitChurn = Record<string, [number, number]>;

export interface YearRow {
  year: number;
  calendar: number;
  restricted: number;
}

export interface Coverage {
  reposListed: number;
  reposWalked: number;
  reposFailed: number;
  reposWithCommits: number;
  churnDone: number;
  churnPending: number;
  churnFailed: number;
  gists: number;
}

export interface CoauthorRow {
  /** Only ever an AI product, a bot, or the `@login` of a publicly linked person. */
  label: string;
  kind: 'ai' | 'bot' | 'person';
  commits: number;
}

export interface CoauthorSummary {
  named: CoauthorRow[];
  /** People who can't be named under the rule in `tallyCoauthors`. */
  privatePeople: number;
  privateCommits: number;
  coauthoredCommits: number;
  soloCommits: number;
  /** Commits with at least one co-author of each kind. */
  byKind: { ai: number; bot: number; person: number };
}

export interface Snapshot {
  version: 1;
  generatedAt: string;
  login: string;
  memberSince: string;
  calendar: { date: string; count: number }[];
  years: YearRow[];
  commits: CommitRow[];
  pulls: PullRow[];
  issues: IssueRow[];
  reviews: ReviewRow[];
  coauthors: CoauthorSummary;
  languages: LanguageBytes[];
  churn: Record<string, CommitChurn>;
  totals: {
    issueComments: number;
    discussions: number;
    organizations: number;
    stars: number;
    followers: number;
  };
  coverage: Coverage;
}

/** [input, output, cacheRead, cacheWrite, messages] */
export type UsageTuple = [number, number, number, number, number];

/** [input, output, cacheRead, cacheWrite] */
export type TokenBreakdown = [number, number, number, number];

/** A lifetime figure reported by a tool itself, which outlives deleted logs. */
export interface ToolTotals {
  /** 'machine' covers this computer. 'account' covers every device on the account. */
  scope: 'machine' | 'account';
  total: number;
  /** The last date the figure covers. Newer usage is added from logs. */
  asOf: string | null;
  /** Lifetime usage per model, when the tool reports it. */
  models?: Record<string, TokenBreakdown>;
  /** Tokens per day, when the tool reports them. */
  daily?: Record<string, number>;
}

export type TokenTotals = Record<string, ToolTotals>;

export interface TokenLedger {
  version: 1;
  /** date -> "tool/model" -> usage. Aggregated, so it is safe to publish. */
  days: Record<string, Record<string, UsageTuple>>;
  /** tool -> lifetime figure. Also aggregated. */
  totals?: TokenTotals;
}

export interface Price {
  input: number;
  output: number;
  cacheRead: number | null;
  cacheWrite: number | null;
}

export type PriceTable = Record<string, Price>;
