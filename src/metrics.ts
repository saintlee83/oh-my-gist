import { DOCS_DATA, SKIPPED } from './github/classify.ts';
import { costOf, findPrice } from './tokens/pricing.ts';
import type { Coverage, PriceTable, Scope, Snapshot, TokenBreakdown, TokenLedger } from './types.ts';
import { hoursBetween, lastDays, lastMonths, median, zoned } from './util/time.ts';

export interface BucketRow {
  key: 'morning' | 'daytime' | 'evening' | 'night';
  label: string;
  emoji: string;
  range: string;
  count: number;
  share: number;
}

/** Lines you added, per source. `bytes` is the repo footprint credited to you, for reference. */
export interface LanguageRow {
  name: string;
  lines: number;
  bytes: number;
  share: number;
  personal: number;
  org: number;
  external: number;
  gist: number;
}

export interface ChurnRow {
  name: string;
  add: number;
  del: number;
  net: number;
}

export interface CoauthorMetricRow {
  label: string;
  kind: 'ai' | 'bot' | 'person' | 'private';
  commits: number;
  share: number;
}

export interface ModelUsage {
  tool: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  messages: number;
  total: number;
  cost: number | null;
}

export interface TokenToolRow {
  tool: string;
  total: number;
  fresh: number;
  cost: number;
  /** Tokens the tool reports but no model can be named for, because no local log covers them. */
  unattributed: number;
  scope: 'machine' | 'account' | 'logs';
  asOf: string | null;
}

export interface TokenMetrics {
  total: number;
  /** Input, output and cache writes. Only covers tokens with a known breakdown. */
  fresh: number;
  cacheRead: number;
  input: number;
  output: number;
  cacheWrite: number;
  /** Model responses found in local logs. */
  messages: number;
  /** A minimum: tokens without a known model or price are left out. */
  cost: number;
  unpricedModels: string[];
  unattributed: number;
  models: ModelUsage[];
  tools: TokenToolRow[];
  /** Trailing 60 days, oldest first. */
  daily: { date: string; total: number; byTool: Record<string, number> }[];
  monthly: { month: string; total: number; byTool: Record<string, number> }[];
  /** Lifetime tokens from before a tool's daily records begin. */
  undated: number;
  last30: { total: number; fresh: number; perCommit: number | null };
  firstDay: string | null;
  activeDays: number;
  peak: { date: string; total: number } | null;
  cacheShare: number;
}

export interface GitHubMetrics {
  login: string;
  memberSince: string;
  counts: {
    commits: number;
    pulls: number;
    merged: number;
    issues: number;
    reviews: number;
    comments: number;
    calendar: number;
    attributed: number;
  };
  /** `calendar` is the year's total on the GitHub graph, including what can't be itemized. */
  thisYear: { year: number; commits: number; pulls: number; issues: number; reviews: number; calendar: number };
  months: string[];
  monthly: { commits: number[]; pulls: number[]; issues: number[]; reviews: number[] };
  years: { year: number; commits: number; pulls: number; issues: number; reviews: number; calendar: number; hidden: number }[];
  /** year -> 12 monthly commit-and-PR-and-review counts; drives the long-range grid. */
  yearGrid: { year: number; months: number[] }[];
  scopes: Record<Scope, { commits: number; pulls: number; issues: number; reviews: number }>;
  rhythm: {
    buckets: BucketRow[];
    punch: number[][];
    weekdays: number[];
    peak: { weekday: number; hour: number; count: number } | null;
    persona: string;
    total: number;
  };
  coauthors: {
    rows: CoauthorMetricRow[];
    coauthored: number;
    solo: number;
    soloShare: number;
    privatePeople: number;
    byKind: { ai: number; bot: number; person: number };
  };
  languages: LanguageRow[];
  languageTotals: Record<'personal' | 'org' | 'external' | 'gist', number>;
  churn: {
    rows: ChurnRow[];
    add: number;
    del: number;
    docs: { add: number; del: number };
    skipped: number;
    bulk: { commits: number; lines: number };
    monthly: { month: string; add: number; del: number }[];
  };
  pulse: {
    streak: number;
    bestStreak: number;
    activeDaysYear: number;
    busiest: { date: string; count: number } | null;
    aiCommits: number;
    aiShare: number;
    aiAgents: { name: string; count: number }[];
    aiShareRecent: number;
    mergeRate: number;
    mergeHours: number | null;
    reviewHours: number | null;
    kinds: { name: string; count: number }[];
    avgCommitSize: number | null;
    stars: number;
    followers: number;
    organizations: number;
  };
  coverage: Coverage;
}

export interface Metrics {
  generatedDate: string;
  timezone: string;
  github: GitHubMetrics | null;
  tokens: TokenMetrics | null;
}

const BUCKETS: Omit<BucketRow, 'count' | 'share'>[] = [
  { key: 'morning', label: 'Morning', emoji: '🌅', range: '06-12' },
  { key: 'daytime', label: 'Daytime', emoji: '🌞', range: '12-18' },
  { key: 'evening', label: 'Evening', emoji: '🌆', range: '18-24' },
  { key: 'night', label: 'Night', emoji: '🌙', range: '00-06' },
];

const PERSONAS: Record<BucketRow['key'], string> = {
  morning: 'early bird',
  daytime: 'day shift',
  evening: 'evening hacker',
  night: 'night owl',
};

function bucketIndex(hour: number): number {
  if (hour < 6) return 3;
  if (hour < 12) return 0;
  if (hour < 18) return 1;
  return 2;
}

function emptyScopes(): GitHubMetrics['scopes'] {
  const row = () => ({ commits: 0, pulls: 0, issues: 0, reviews: 0 });
  return { personal: row(), org: row(), external: row() };
}

/** A streak survives until the end of today, so an empty today does not reset it. */
export function streaks(calendar: { date: string; count: number }[], today: string): { current: number; best: number } {
  const active = new Set(calendar.filter((day) => day.count > 0).map((day) => day.date));
  let best = 0;
  let run = 0;
  let previous: number | null = null;
  for (const date of [...active].sort()) {
    const time = new Date(`${date}T00:00:00Z`).getTime();
    run = previous !== null && time - previous === 86_400_000 ? run + 1 : 1;
    best = Math.max(best, run);
    previous = time;
  }
  let current = 0;
  const [yesterday, now] = lastDays(today, 2);
  let cursor = active.has(now) ? now : yesterday;
  while (active.has(cursor)) {
    current++;
    cursor = lastDays(cursor, 2)[0];
  }
  return { current, best };
}

export interface MetricsOptions {
  maxCommitLines?: number;
  excludeLanguages?: string[];
}

export const DEFAULT_MAX_COMMIT_LINES = 20_000;

export function computeGitHub(snapshot: Snapshot, timezone: string, now: Date, options: MetricsOptions = {}): GitHubMetrics {
  const maxCommitLines = options.maxCommitLines ?? DEFAULT_MAX_COMMIT_LINES;
  const excluded = new Set((options.excludeLanguages ?? []).map((name) => name.toLowerCase()));
  const today = zoned(now, timezone);
  const months = lastMonths(today.month, 12);
  const monthIndex = new Map(months.map((month, index) => [month, index]));
  const monthly = {
    commits: months.map(() => 0),
    pulls: months.map(() => 0),
    issues: months.map(() => 0),
    reviews: months.map(() => 0),
  };

  const punch = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  const bucketCounts = [0, 0, 0, 0];
  const scopes = emptyScopes();
  const yearly = new Map<number, { commits: number; pulls: number; issues: number; reviews: number }>();
  const grid = new Map<number, number[]>();
  const yearRow = (year: number) => {
    let row = yearly.get(year);
    if (!row) yearly.set(year, (row = { commits: 0, pulls: 0, issues: 0, reviews: 0 }));
    return row;
  };

  const record = (
    instant: string,
    kind: 'commits' | 'pulls' | 'issues' | 'reviews',
    scope: Scope,
  ) => {
    const at = zoned(instant, timezone);
    punch[at.weekday][at.hour]++;
    bucketCounts[bucketIndex(at.hour)]++;
    scopes[scope][kind]++;
    yearRow(at.year)[kind]++;
    const index = monthIndex.get(at.month);
    if (index !== undefined) monthly[kind][index]++;
    let row = grid.get(at.year);
    if (!row) grid.set(at.year, (row = Array.from({ length: 12 }, () => 0)));
    row[Number(at.month.slice(5)) - 1]++;
  };

  for (const commit of snapshot.commits) record(commit.at, 'commits', commit.scope);
  for (const pull of snapshot.pulls) record(pull.createdAt, 'pulls', pull.scope);
  for (const issue of snapshot.issues) record(issue.createdAt, 'issues', issue.scope);
  for (const review of snapshot.reviews) record(review.at, 'reviews', review.scope);

  const rhythmTotal = bucketCounts.reduce((sum, value) => sum + value, 0);
  const buckets: BucketRow[] = BUCKETS.map((bucket, index) => ({
    ...bucket,
    count: bucketCounts[index],
    share: rhythmTotal ? bucketCounts[index] / rhythmTotal : 0,
  }));
  let peak: GitHubMetrics['rhythm']['peak'] = null;
  punch.forEach((hours, weekday) =>
    hours.forEach((count, hour) => {
      if (count > (peak?.count ?? 0)) peak = { weekday, hour, count };
    }),
  );
  const topBucket = [...buckets].sort((a, b) => b.count - a.count)[0];

  const churnTotals = new Map<string, ChurnRow>();
  const churnMonths = new Map<string, { add: number; del: number }>();
  const written = new Map<string, Record<Scope, number>>();
  const bulk = { commits: 0, lines: 0 };
  let docs = { add: 0, del: 0 };
  let skipped = 0;
  for (const commit of snapshot.commits) {
    const entry = snapshot.churn[commit.oid];
    if (!entry) continue;
    const month = zoned(commit.at, timezone).month;

    let codeLines = 0;
    let docLines = 0;
    for (const [language, [add, del]] of Object.entries(entry)) {
      if (language === SKIPPED) skipped += add + del;
      else if (language === DOCS_DATA) docLines += add + del;
      else codeLines += add + del;
    }
    // One commit touching this much is an import, however it is laid out across files.
    const bulkCode = codeLines > maxCommitLines;
    const bulkDocs = docLines > maxCommitLines;
    if (bulkCode || bulkDocs) {
      bulk.commits++;
      bulk.lines += (bulkCode ? codeLines : 0) + (bulkDocs ? docLines : 0);
    }

    for (const [language, [add, del]] of Object.entries(entry)) {
      if (language === SKIPPED) continue;
      if (language === DOCS_DATA) {
        if (!bulkDocs) docs = { add: docs.add + add, del: docs.del + del };
        continue;
      }
      if (bulkCode || excluded.has(language.toLowerCase())) continue;
      const row = churnTotals.get(language) ?? { name: language, add: 0, del: 0, net: 0 };
      row.add += add;
      row.del += del;
      row.net = row.add - row.del;
      churnTotals.set(language, row);
      const bucket = churnMonths.get(month) ?? { add: 0, del: 0 };
      bucket.add += add;
      bucket.del += del;
      churnMonths.set(month, bucket);
      const lines = written.get(language) ?? { personal: 0, org: 0, external: 0 };
      lines[commit.scope] += add;
      written.set(language, lines);
    }
  }
  const churnRows = [...churnTotals.values()].sort((a, b) => b.add + b.del - (a.add + a.del));

  const footprint = new Map(snapshot.languages.map((row) => [row.name, row]));
  const languageTotals = { personal: 0, org: 0, external: 0, gist: 0 };
  const languageRows = [...new Set([...written.keys(), ...footprint.keys()])].map((name) => {
    const lines = written.get(name) ?? { personal: 0, org: 0, external: 0 };
    const raw = footprint.get(name);
    const gist = raw?.gistLines ?? 0;
    languageTotals.personal += lines.personal;
    languageTotals.org += lines.org;
    languageTotals.external += lines.external;
    languageTotals.gist += gist;
    return {
      name,
      lines: lines.personal + lines.org + lines.external + gist,
      bytes: raw ? raw.personal + raw.org + raw.external + raw.gist : 0,
      share: 0,
      personal: lines.personal,
      org: lines.org,
      external: lines.external,
      gist,
    };
  });
  const totalLines = languageRows.reduce((sum, row) => sum + row.lines, 0);
  const languages: LanguageRow[] = languageRows
    .map((row) => ({ ...row, share: totalLines ? row.lines / totalLines : 0 }))
    .sort((a, b) => b.lines - a.lines || b.bytes - a.bytes);

  const merged = snapshot.pulls.filter((pull) => pull.mergedAt);
  const mergeTimes = merged.map((pull) => hoursBetween(pull.createdAt, pull.mergedAt as string)).filter((value) => value >= 0);
  const reviewTimes = snapshot.reviews.map((review) => hoursBetween(review.prCreatedAt, review.at)).filter((value) => value >= 0);

  const authored = snapshot.commits.filter((commit) => !commit.merge);
  const agents = new Map<string, number>();
  const kinds = new Map<string, number>();
  let aiCommits = 0;
  for (const commit of authored) {
    if (commit.ai) {
      aiCommits++;
      agents.set(commit.ai, (agents.get(commit.ai) ?? 0) + 1);
    }
    if (commit.kind) kinds.set(commit.kind, (kinds.get(commit.kind) ?? 0) + 1);
  }
  const recentCutoff = now.getTime() - 90 * 86_400_000;
  const recent = authored.filter((commit) => new Date(commit.at).getTime() >= recentCutoff);
  const sizes = authored.map((commit) => commit.add + commit.del).filter((size) => size > 0);

  const { current, best } = streaks(snapshot.calendar, today.date);
  const activeWindow = new Set(lastDays(today.date, 365));
  const activeDaysYear = snapshot.calendar.filter((day) => day.count > 0 && activeWindow.has(day.date)).length;
  const busiest = snapshot.calendar.reduce<{ date: string; count: number } | null>(
    (top, day) => (day.count > (top?.count ?? 0) ? day : top),
    null,
  );

  const calendarByYear = new Map(snapshot.years.map((row) => [row.year, row]));
  const allYears = new Set([...yearly.keys(), ...calendarByYear.keys()]);
  const years = [...allYears]
    .sort((a, b) => b - a)
    .map((year) => {
      const row = yearly.get(year) ?? { commits: 0, pulls: 0, issues: 0, reviews: 0 };
      const official = calendarByYear.get(year);
      return { year, ...row, calendar: official?.calendar ?? 0, hidden: official?.restricted ?? 0 };
    })
    .filter((row) => row.commits + row.pulls + row.issues + row.reviews + row.calendar > 0);

  const counts = {
    commits: snapshot.commits.length,
    pulls: snapshot.pulls.length,
    merged: merged.length,
    issues: snapshot.issues.length,
    reviews: snapshot.reviews.length,
    comments: snapshot.totals.issueComments,
    calendar: snapshot.calendar.reduce((sum, day) => sum + day.count, 0),
    attributed: 0,
  };
  counts.attributed = counts.commits + counts.pulls + counts.issues + counts.reviews;

  const thisYear = yearRow(today.year);

  const { coauthors } = snapshot;
  const coauthorRows: CoauthorMetricRow[] = coauthors.named.map((row) => ({
    ...row,
    share: coauthors.coauthoredCommits ? row.commits / coauthors.coauthoredCommits : 0,
  }));
  if (coauthors.privateCommits > 0) {
    coauthorRows.push({
      label: `Private (${coauthors.privatePeople} ${coauthors.privatePeople === 1 ? 'person' : 'people'})`,
      kind: 'private',
      commits: coauthors.privateCommits,
      share: coauthors.coauthoredCommits ? coauthors.privateCommits / coauthors.coauthoredCommits : 0,
    });
  }
  coauthorRows.sort((a, b) => b.commits - a.commits);
  const soloDenominator = coauthors.soloCommits + coauthors.coauthoredCommits;

  return {
    login: snapshot.login,
    memberSince: snapshot.memberSince,
    counts,
    thisYear: {
      year: today.year,
      ...thisYear,
      calendar: snapshot.calendar
        .filter((day) => day.date.startsWith(`${today.year}-`))
        .reduce((sum, day) => sum + day.count, 0),
    },
    months,
    monthly,
    years,
    yearGrid: [...grid.entries()].sort((a, b) => b[0] - a[0]).map(([year, values]) => ({ year, months: values })),
    scopes,
    rhythm: {
      buckets,
      punch,
      weekdays: punch.map((hours) => hours.reduce((sum, value) => sum + value, 0)),
      peak,
      persona: rhythmTotal ? PERSONAS[topBucket.key] : 'just getting started',
      total: rhythmTotal,
    },
    coauthors: {
      rows: coauthorRows,
      coauthored: coauthors.coauthoredCommits,
      solo: coauthors.soloCommits,
      soloShare: soloDenominator ? coauthors.soloCommits / soloDenominator : 0,
      privatePeople: coauthors.privatePeople,
      byKind: coauthors.byKind,
    },
    languages,
    languageTotals,
    churn: {
      rows: churnRows,
      add: churnRows.reduce((sum, row) => sum + row.add, 0),
      del: churnRows.reduce((sum, row) => sum + row.del, 0),
      docs,
      skipped,
      bulk,
      monthly: [...churnMonths.entries()].sort().map(([month, value]) => ({ month, ...value })),
    },
    pulse: {
      streak: current,
      bestStreak: best,
      activeDaysYear,
      busiest,
      aiCommits,
      aiShare: authored.length ? aiCommits / authored.length : 0,
      aiAgents: [...agents.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
      aiShareRecent: recent.length ? recent.filter((commit) => commit.ai).length / recent.length : 0,
      mergeRate: counts.pulls ? counts.merged / counts.pulls : 0,
      mergeHours: median(mergeTimes),
      reviewHours: median(reviewTimes),
      kinds: [...kinds.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
      avgCommitSize: median(sizes),
      stars: snapshot.totals.stars,
      followers: snapshot.totals.followers,
      organizations: snapshot.totals.organizations,
    },
    coverage: snapshot.coverage,
  };
}

const breakdownTotal = (usage: TokenBreakdown) => usage[0] + usage[1] + usage[2] + usage[3];

export function computeTokens(
  ledger: TokenLedger,
  prices: PriceTable,
  timezone: string,
  now: Date,
  commits: { at: string }[] | null,
): TokenMetrics | null {
  const dates = Object.keys(ledger.days).sort();
  const totals = ledger.totals ?? {};
  if (dates.length === 0 && Object.keys(totals).length === 0) return null;

  const today = zoned(now, timezone).date;
  const window30 = new Set(lastDays(today, 30));

  // What the local logs hold, and which part is newer than a tool's own figure.
  const logged = new Map<string, { tool: string; model: string; usage: TokenBreakdown; newer: TokenBreakdown; messages: number }>();
  const days = new Map<string, Record<string, number>>();
  const raiseDay = (date: string, tool: string, value: number) => {
    const day = days.get(date) ?? {};
    day[tool] = Math.max(day[tool] ?? 0, value);
    days.set(date, day);
  };
  const logDays = new Map<string, Record<string, number>>();
  let last30Fresh = 0;

  for (const date of dates) {
    for (const [key, [input, output, cacheRead, cacheWrite, messages]] of Object.entries(ledger.days[date])) {
      const slash = key.indexOf('/');
      const tool = key.slice(0, slash);
      const model = key.slice(slash + 1);
      const row = logged.get(key) ?? { tool, model, usage: [0, 0, 0, 0] as TokenBreakdown, newer: [0, 0, 0, 0] as TokenBreakdown, messages: 0 };
      const usage: TokenBreakdown = [input, output, cacheRead, cacheWrite];
      usage.forEach((value, index) => (row.usage[index] += value));
      const asOf = totals[tool]?.asOf;
      if (asOf && date > asOf) usage.forEach((value, index) => (row.newer[index] += value));
      row.messages += messages;
      logged.set(key, row);

      const day = logDays.get(date) ?? {};
      day[tool] = (day[tool] ?? 0) + breakdownTotal(usage);
      logDays.set(date, day);
      if (window30.has(date)) last30Fresh += input + output + cacheWrite;
    }
  }
  // A tool's own daily figures win up to their last date. Mixing in logs would count
  // usage twice whenever the two sources put it on neighbouring days.
  for (const [date, day] of logDays) {
    for (const [tool, value] of Object.entries(day)) {
      const figure = totals[tool];
      const covered = figure?.asOf && Object.keys(figure.daily ?? {}).length > 0 && date <= figure.asOf;
      if (!covered) raiseDay(date, tool, value);
    }
  }
  for (const [tool, figure] of Object.entries(totals)) {
    for (const [date, value] of Object.entries(figure.daily ?? {})) raiseDay(date, tool, value);
  }

  // Per model: the tool's own lifetime figure when it has one, otherwise the logs.
  const rows = new Map<string, ModelUsage>();
  const addRow = (tool: string, model: string, usage: TokenBreakdown, messages: number) => {
    const [input, output, cacheRead, cacheWrite] = usage;
    const price = findPrice(prices, model);
    rows.set(`${tool}/${model}`, {
      tool,
      model,
      input,
      output,
      cacheRead,
      cacheWrite,
      messages,
      total: breakdownTotal(usage),
      cost: price ? costOf(price, { input, output, cacheRead, cacheWrite }) : null,
    });
  };
  for (const [tool, figure] of Object.entries(totals)) {
    for (const [model, usage] of Object.entries(figure.models ?? {})) {
      const log = logged.get(`${tool}/${model}`);
      const combined = usage.map((value, index) => value + (log?.newer[index] ?? 0)) as TokenBreakdown;
      const best = log && breakdownTotal(log.usage) > breakdownTotal(combined) ? log.usage : combined;
      addRow(tool, model, best, log?.messages ?? 0);
    }
  }
  for (const [key, log] of logged) {
    if (!rows.has(key)) addRow(log.tool, log.model, log.usage, log.messages);
  }
  const modelRows = [...rows.values()].sort((a, b) => b.total - a.total);

  const toolNames = new Set([...Object.keys(totals), ...modelRows.map((row) => row.tool)]);
  const toolRows: TokenToolRow[] = [...toolNames]
    .map((tool) => {
      const own = modelRows.filter((row) => row.tool === tool);
      const known = own.reduce((sum, row) => sum + row.total, 0);
      const figure = totals[tool];
      const newer = [...logged.values()].filter((row) => row.tool === tool).reduce((sum, row) => sum + breakdownTotal(row.newer), 0);
      const total = figure ? Math.max(figure.total + newer, known) : known;
      return {
        tool,
        total,
        fresh: own.reduce((sum, row) => sum + row.input + row.output + row.cacheWrite, 0),
        cost: own.reduce((sum, row) => sum + (row.cost ?? 0), 0),
        unattributed: Math.max(0, total - known),
        scope: figure?.scope ?? ('logs' as const),
        asOf: figure?.asOf ?? null,
      };
    })
    .sort((a, b) => b.total - a.total);

  const allDates = [...days.keys()].sort();
  const dayTotal = (date: string) => Object.values(days.get(date) ?? {}).reduce((sum, value) => sum + value, 0);
  const monthly = new Map<string, { month: string; total: number; byTool: Record<string, number> }>();
  const datedByTool: Record<string, number> = {};
  for (const date of allDates) {
    const month = date.slice(0, 7);
    const row = monthly.get(month) ?? { month, total: 0, byTool: {} };
    for (const [tool, value] of Object.entries(days.get(date) ?? {})) {
      row.total += value;
      row.byTool[tool] = (row.byTool[tool] ?? 0) + value;
      datedByTool[tool] = (datedByTool[tool] ?? 0) + value;
    }
    monthly.set(month, row);
  }

  let peak: TokenMetrics['peak'] = null;
  for (const date of allDates) {
    const total = dayTotal(date);
    if (total > (peak?.total ?? 0)) peak = { date, total };
  }

  let perCommit: number | null = null;
  if (commits) {
    const recentCommits = commits.filter((commit) => window30.has(zoned(commit.at, timezone).date)).length;
    perCommit = recentCommits ? last30Fresh / recentCommits : null;
  }

  const sum = (pick: (row: ModelUsage) => number) => modelRows.reduce((total, row) => total + pick(row), 0);
  const input = sum((row) => row.input);
  const cacheRead = sum((row) => row.cacheRead);
  const cacheWrite = sum((row) => row.cacheWrite);
  const output = sum((row) => row.output);
  return {
    total: toolRows.reduce((total, row) => total + row.total, 0),
    fresh: input + output + cacheWrite,
    input,
    output,
    cacheRead,
    cacheWrite,
    messages: sum((row) => row.messages),
    cost: sum((row) => row.cost ?? 0),
    unpricedModels: modelRows.filter((row) => row.cost === null).map((row) => row.model),
    unattributed: toolRows.reduce((total, row) => total + row.unattributed, 0),
    models: modelRows,
    tools: toolRows,
    daily: lastDays(today, 60).map((date) => ({ date, total: dayTotal(date), byTool: { ...days.get(date) } })),
    monthly: [...monthly.values()].sort((a, b) => a.month.localeCompare(b.month)),
    undated: toolRows.reduce((total, row) => total + Math.max(0, row.total - (datedByTool[row.tool] ?? 0)), 0),
    last30: { total: [...window30].reduce((total, date) => total + dayTotal(date), 0), fresh: last30Fresh, perCommit },
    firstDay: allDates[0] ?? null,
    activeDays: allDates.filter((date) => dayTotal(date) > 0).length,
    peak,
    cacheShare: input + cacheRead + cacheWrite ? cacheRead / (input + cacheRead + cacheWrite) : 0,
  };
}

export function computeMetrics(
  snapshot: Snapshot | null,
  ledger: TokenLedger | null,
  prices: PriceTable,
  timezone: string,
  now: Date,
  options: MetricsOptions = {},
): Metrics {
  return {
    generatedDate: zoned(now, timezone).date,
    timezone,
    github: snapshot ? computeGitHub(snapshot, timezone, now, options) : null,
    tokens: ledger ? computeTokens(ledger, prices, timezone, now, snapshot?.commits ?? null) : null,
  };
}
