import type { GitHubMetrics, Metrics, TokenMetrics } from '../metrics.ts';
import {
  bar,
  bytes,
  clip,
  commas,
  compact,
  displayWidth,
  hours,
  money,
  padEnd,
  padStart,
  percent,
  sparkline,
  table,
} from '../util/format.ts';
import { WEEKDAYS } from '../util/time.ts';

/**
 * GitHub shows the first five lines of a pinned gist at 11px and clips the rest
 * of each line. Measured on a live profile, about 53 monospace cells are visible.
 */
export const CARD_LINES = 5;
export const CARD_WIDTH = 52;

export type CardKey = 'contributions' | 'rhythm' | 'languages' | 'churn' | 'tokens' | 'coauthors' | 'pulse';

export interface Card {
  key: CardKey;
  /** GitHub uses the gist description as the card title. */
  title: string;
  filename: string;
  hero: string[];
  details: string[];
}

export function cardContent(card: Card, date: string): string {
  const footer = `Updated ${date} · github.com/saintlee83/oh-my-gist`;
  const body = [...card.hero, '', ...card.details];
  return `${body.join('\n').trimEnd()}\n\n${footer}\n`;
}

function contributionsCard(github: GitHubMetrics): Card {
  const { counts, thisYear, monthly } = github;
  const year = String(thisYear.year);
  const row = (label: string, total: number, current: number, series: number[]) =>
    `${padEnd(label, 13)}${padStart(commas(current), 7)}${padStart(commas(total), 9)}  ${sparkline(series)}`;

  const hero = [
    `${padEnd('', 13)}${padStart(year, 7)}${padStart('lifetime', 9)}  last 12 months`,
    row('Commits', counts.commits, thisYear.commits, monthly.commits),
    row('Pull requests', counts.pulls, thisYear.pulls, monthly.pulls),
    row('Code reviews', counts.reviews, thisYear.reviews, monthly.reviews),
    row('Issues', counts.issues, thisYear.issues, monthly.issues),
  ];

  const scopeRows = (['personal', 'org', 'external'] as const).map((scope) => {
    const item = github.scopes[scope];
    const label = { personal: 'Personal repos', org: 'Organizations', external: 'Other repos' }[scope];
    return [label, commas(item.commits), commas(item.pulls), commas(item.reviews), commas(item.issues)];
  });
  const details = [
    'BY YEAR',
    ...table(
      [
        ['Year', 'Commits', 'PRs', 'Reviews', 'Issues', 'GitHub graph'],
        ...github.years.map((item) => [
          String(item.year),
          commas(item.commits),
          commas(item.pulls),
          commas(item.reviews),
          commas(item.issues),
          commas(item.calendar),
        ]),
      ],
      ['l', 'r', 'r', 'r', 'r', 'r'],
    ),
    '',
    'BY WHERE',
    ...table([['', 'Commits', 'PRs', 'Reviews', 'Issues'], ...scopeRows], ['l', 'r', 'r', 'r', 'r']),
    '',
    'ALSO',
    `Merged PRs       ${commas(counts.merged)}`,
    `Issue comments   ${commas(counts.comments)}`,
    `Repos committed  ${commas(github.coverage.reposWithCommits)} of ${commas(github.coverage.reposListed)}`,
    `Organizations    ${commas(github.pulse.organizations)}`,
    '',
    'HOW THIS IS COUNTED',
    'Commits are walked repo by repo on the default branch, because GitHub hides',
    'the breakdown of private work from its contribution API.',
    `Your GitHub graph shows ${commas(thisYear.calendar)} in ${year} and ${commas(counts.calendar)} lifetime; ${commas(counts.attributed)} are itemized. The rest is activity`,
    'GitHub counts but does not list per repo, such as work in repositories that were',
    'later deleted or rewritten. Code reviews are PRs by other people that you reviewed.',
  ];

  return {
    key: 'contributions',
    title: `⚡ Contributions: ${compact(thisYear.calendar)} in ${year} · ${compact(counts.calendar)} lifetime`,
    filename: 'oh-my-gist-contributions.txt',
    hero,
    details,
  };
}

function rhythmCard(github: GitHubMetrics, timezone: string): Card {
  const { rhythm } = github;
  const ordered = rhythm.buckets;
  const hero = ordered.map(
    (bucket) =>
      `${bucket.emoji} ${padEnd(bucket.label, 8)}${bucket.range}${padStart(commas(bucket.count), 7)} ${bar(bucket.share, 16)} ${padStart(percent(bucket.share), 6)}`,
  );
  const peak = rhythm.peak
    ? `Peak ${WEEKDAYS[rhythm.peak.weekday]} ${String(rhythm.peak.hour).padStart(2, '0')}:00`
    : 'No activity yet';
  hero.push(clip(`${peak} · ${rhythm.persona} · ${timezone}`, CARD_WIDTH));

  const max = Math.max(1, ...rhythm.punch.flat());
  const shades = ['·', '░', '▒', '▓', '█'];
  const cell = (value: number) => (value === 0 ? shades[0] : shades[Math.max(1, Math.ceil(Math.sqrt(value / max) * 4))]);
  const header = `     ${Array.from({ length: 24 }, (_, hour) => (hour % 6 === 0 ? String(hour).padStart(2, '0') : '  ')).join('')}`;
  const weekTotal = Math.max(1, ...rhythm.weekdays);

  const details = [
    'WEEKDAY x HOUR',
    header.trimEnd(),
    ...rhythm.punch.map((row, weekday) => `${WEEKDAYS[weekday]}  ${row.map((value) => cell(value).repeat(2)).join('')}`),
    '',
    'BY WEEKDAY',
    ...rhythm.weekdays.map(
      (count, weekday) => `${WEEKDAYS[weekday]}  ${bar(count / weekTotal, 20)} ${padStart(commas(count), 6)}`,
    ),
    '',
    `${commas(rhythm.total)} timestamped events: commits, PRs, issues and reviews.`,
    `Times are shown in ${timezone}; GitHub stores them in UTC.`,
  ];

  return {
    key: 'rhythm',
    title: `🕒 Coding rhythm: ${rhythm.persona}`,
    filename: 'oh-my-gist-rhythm.txt',
    hero,
    details,
  };
}

function languagesCard(github: GitHubMetrics): Card {
  const line = (name: string, lines: number, share: number) =>
    `${padEnd(clip(name, 16), 16)} ${padStart(compact(lines), 7)} ${bar(share, 20)} ${padStart(percent(share), 6)}`;
  const hero = github.languages
    .filter((row) => row.lines > 0)
    .slice(0, CARD_LINES)
    .map((row) => line(row.name, row.lines, row.share));
  if (hero.length === 0) hero.push('No language data yet.');

  const totals = github.languageTotals;
  const details = [
    'EVERY LANGUAGE',
    ...table(
      [
        ['Language', 'Lines', 'Share', 'Personal', 'Orgs', 'Gists', 'Other', 'Repo bytes'],
        ...github.languages.map((row) => [
          row.name,
          row.lines ? commas(row.lines) : '-',
          row.lines ? percent(row.share, 2) : '-',
          row.personal ? commas(row.personal) : '-',
          row.org ? commas(row.org) : '-',
          row.gist ? commas(row.gist) : '-',
          row.external ? commas(row.external) : '-',
          row.bytes ? bytes(row.bytes) : '-',
        ]),
      ],
      ['l', 'r', 'r', 'r', 'r', 'r', 'r', 'r'],
    ),
    '',
    `Lines by source: personal ${compact(totals.personal)} · orgs ${compact(totals.org)} · gists ${compact(totals.gist)} (${github.coverage.gists} scanned) · other ${compact(totals.external)}`,
    '',
    'HOW THIS IS COUNTED',
    'Ranked by lines you added, because bytes in a repo cannot tell an imported SDK',
    'from code you wrote. Vendored and generated files, merges and bulk imports are',
    'left out. Secret gists are included.',
    "Repo bytes is each repo's size per language, credited by your share of its commits.",
  ];

  return {
    key: 'languages',
    title: `🧬 Top languages: ${clip(github.languages[0]?.name ?? 'none yet', 24)} leads ${github.languages.length} languages`,
    filename: 'oh-my-gist-languages.txt',
    hero,
    details,
  };
}

/** Both arms share one scale, so bar lengths can be compared across the axis. */
export function churnLine(name: string, add: number, del: number, scale: number): string {
  const arm = 10;
  const cells = (value: number) => (value <= 0 ? 0 : Math.max(1, Math.round((value / scale) * arm)));
  const removed = padStart('▒'.repeat(cells(del)), arm);
  const added = padEnd('█'.repeat(cells(add)), arm);
  return `${padEnd(clip(name, 13), 13)} ${padStart(`-${compact(del)}`, 7)} ${removed}│${added} ${padStart(`+${compact(add)}`, 7)}`;
}

function churnCard(github: GitHubMetrics): Card {
  const { churn, coverage } = github;
  const top = churn.rows.slice(0, CARD_LINES);
  const scale = Math.max(1, ...top.flatMap((row) => [row.add, row.del]));
  const hero = top.map((row) => churnLine(row.name, row.add, row.del, scale));

  const recent = churn.monthly.slice(-12);
  const monthScale = Math.max(1, ...recent.flatMap((row) => [row.add, row.del]));
  const pending = coverage.churnPending;
  const details = [
    'EVERY LANGUAGE',
    ...table(
      [
        ['Language', 'Added', 'Removed', 'Net'],
        ...churn.rows.map((row) => [
          row.name,
          `+${commas(row.add)}`,
          `-${commas(row.del)}`,
          `${row.net >= 0 ? '+' : '-'}${commas(Math.abs(row.net))}`,
        ]),
        ['Total', `+${commas(churn.add)}`, `-${commas(churn.del)}`, `${churn.add >= churn.del ? '+' : '-'}${commas(Math.abs(churn.add - churn.del))}`],
      ],
      ['l', 'r', 'r', 'r'],
    ),
    '',
    'BY MONTH',
    ...recent.map((row) => churnLine(row.month, row.add, row.del, monthScale)),
    '',
    'NOT COUNTED ABOVE',
    `Docs & data  +${commas(churn.docs.add)} / -${commas(churn.docs.del)} (Markdown, JSON, YAML, config)`,
    `Skipped      ${commas(churn.skipped)} lines (lockfiles, vendored, generated, unknown types)`,
    `Bulk imports ${commas(churn.bulk.lines)} lines in ${commas(churn.bulk.commits)} commits (one commit over the size limit)`,
    '',
    'COVERAGE',
    `${commas(coverage.churnDone)} commits analyzed${pending ? `, ${commas(pending)} pending and fetched on later runs` : ''}.`,
    'Merge commits are excluded. Files with very large single diffs are treated as generated.',
  ];

  return {
    key: 'churn',
    title: `± Language churn: +${compact(churn.add)} / -${compact(churn.del)} lines`,
    filename: 'oh-my-gist-churn.txt',
    hero,
    details,
  };
}

function shortModel(model: string): string {
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

const TOOL_NAMES: Record<string, string> = { claude: 'Claude', codex: 'Codex' };
const toolName = (tool: string) => TOOL_NAMES[tool] ?? tool;
const SOURCE_LABELS = {
  machine: 'its own statistics, this machine',
  account: 'your account, every device',
  logs: 'local logs, this machine',
};

function tokensCard(tokens: TokenMetrics): Card {
  const isMinimum = tokens.unpricedModels.length > 0 || tokens.unattributed > 0;
  const costLabel = `${isMinimum ? '≥' : '≈'}${money(tokens.cost)}`;
  const perTool = tokens.tools.map((row) => `${toolName(row.tool)} ${compact(row.total)}`).join(' ');
  // The card title already says "tokens", so the word goes first when space is tight.
  const headline = `${compact(tokens.total)} tokens · ${costLabel} API · ${perTool}`;
  const hero = [clip(displayWidth(headline) <= CARD_WIDTH ? headline : `${compact(tokens.total)} · ${costLabel} API · ${perTool}`, CARD_WIDTH)];
  for (const row of tokens.models.slice(0, 3)) {
    const share = tokens.total ? row.total / tokens.total : 0;
    const cost = row.cost === null ? '   n/a' : padStart(money(row.cost), 6);
    hero.push(
      `${padEnd(clip(shortModel(row.model), 12), 12)} ${padStart(compact(row.total), 6)} ${bar(share, 14)} ${padStart(percent(share, 0), 4)} ${cost}`,
    );
  }
  const recent = tokens.daily.slice(-30).map((day) => day.total);
  hero.push(`30d ${sparkline(recent)} ${compact(tokens.last30.total)}`.slice(0, CARD_WIDTH));

  const monthTools = tokens.tools.map((row) => row.tool);
  const details = [
    'BY TOOL',
    ...table(
      [
        ['Tool', 'Total', 'API cost', 'Source', 'Through'],
        ...tokens.tools.map((row) => [toolName(row.tool), compact(row.total), money(row.cost), SOURCE_LABELS[row.scope], row.asOf ?? '-']),
      ],
      ['l', 'r', 'r', 'l', 'l'],
    ),
    '',
    'BY MODEL',
    ...table(
      [
        ['Model', 'Total', 'Input', 'Output', 'Cache read', 'Cache write', 'API cost'],
        ...tokens.models.map((row) => [
          row.model,
          compact(row.total),
          compact(row.input),
          compact(row.output),
          compact(row.cacheRead),
          compact(row.cacheWrite),
          row.cost === null ? 'n/a' : money(row.cost),
        ]),
        ...(tokens.unattributed > 0 ? [['Model unknown', compact(tokens.unattributed), '-', '-', '-', '-', 'n/a']] : []),
      ],
      ['l', 'r', 'r', 'r', 'r', 'r', 'r'],
    ),
    '',
    'BY MONTH',
    ...table(
      [
        ['Month', ...monthTools.map(toolName), 'Total'],
        ...tokens.monthly.map((row) => [row.month, ...monthTools.map((tool) => compact(row.byTool[tool] ?? 0)), compact(row.total)]),
        ...(tokens.undated > 0 ? [['Earlier', ...monthTools.map(() => ''), compact(tokens.undated)]] : []),
      ],
      ['l', ...monthTools.map(() => 'r' as const), 'r'],
    ),
    '',
    'SUMMARY',
    `Cache hit rate   ${percent(tokens.cacheShare)}${tokens.unattributed > 0 ? ' (where the breakdown is known)' : ''}`,
    `Active days      ${commas(tokens.activeDays)}${tokens.firstDay ? ` since ${tokens.firstDay}` : ''}`,
    ...(tokens.peak ? [`Peak day         ${tokens.peak.date} (${compact(tokens.peak.total)})`] : []),
    `Last 30 days     ${compact(tokens.last30.total)}`,
    ...(tokens.last30.perCommit ? [`Uncached/commit  ${compact(tokens.last30.perCommit)} over 30 days, from this machine's logs`] : []),
    '',
    'HOW THIS IS COUNTED',
    "Claude Code: its own lifetime statistics on this machine, which survive log cleanup.",
    "Codex: your account's lifetime total, the figure behind /usage, across every device.",
    'So the two have different reach, and usage on other machines may be missing for Claude.',
    "Codex's model split comes from local logs, so tokens outside them have no known model.",
    'Without those sources, this falls back to counting local logs, once per model response.',
    'Only totals per day and model leave the machine, never prompts, code or paths.',
    '"API" is what this usage would cost at public list prices, not what was paid. It is a',
    'minimum when "≥" appears, because tokens without a known model or price are left out.',
    ...(tokens.unpricedModels.length ? [`No public price for: ${tokens.unpricedModels.join(', ')}.`] : []),
  ];

  return {
    key: 'tokens',
    title: `🪙 AI token trace: ${compact(tokens.total)} tokens`,
    filename: 'oh-my-gist-tokens.txt',
    hero,
    details,
  };
}

function coauthorsCard(github: GitHubMetrics): Card {
  const { coauthors } = github;
  const line = (label: string, commits: number, share: number) =>
    `${padEnd(clip(label, 19), 19)} ${padStart(commas(commits), 6)} ${bar(share, 17)} ${padStart(percent(share, 0), 4)}`;

  const hero = coauthors.rows.slice(0, CARD_LINES).map((row) => line(row.label, row.commits, row.share));
  if (hero.length === 0) hero.push('No co-authored commits yet.');
  else if (hero.length < CARD_LINES) hero.push(`Solo${padStart(commas(coauthors.solo), 22)} commits (${percent(coauthors.soloShare, 0)} of all)`);

  const kindLabel = { ai: 'AI', bot: 'Bot', person: 'Person', private: 'Private' };
  const details = [
    'EVERY CO-AUTHOR',
    ...(coauthors.rows.length
      ? table(
          [
            ['Co-author', 'Type', 'Commits', 'Share'],
            ...coauthors.rows.map((row) => [row.label, kindLabel[row.kind], commas(row.commits), percent(row.share)]),
          ],
          ['l', 'l', 'r', 'r'],
        )
      : ['None yet.']),
    '',
    'SOLO VS CO-AUTHORED',
    `Co-authored  ${padStart(commas(coauthors.coauthored), 7)}`,
    `Solo         ${padStart(commas(coauthors.solo), 7)}`,
    '',
    'WITH WHOM',
    `AI assistants  ${padStart(commas(coauthors.byKind.ai), 7)} commits`,
    `People         ${padStart(commas(coauthors.byKind.person), 7)} commits`,
    `Bots           ${padStart(commas(coauthors.byKind.bot), 7)} commits`,
    '',
    'HOW THIS IS COUNTED',
    'From Co-authored-by trailers on your commits. Share is of co-authored commits,',
    'and a commit with two co-authors counts for both, so shares can exceed 100%.',
    'AI assistants and bots are named. People are named only if they have a GitHub',
    'account and co-authored in a public repo, counting those public commits only,',
    'or if listed in namedCoauthors. Everyone else is an anonymous count. Email',
    'addresses are never published.',
  ];

  const top = coauthors.rows[0];
  return {
    key: 'coauthors',
    title: top ? `🤝 Top coauthored with: ${clip(top.label, 30)}` : '🤝 Top coauthored with',
    filename: 'oh-my-gist-coauthors.txt',
    hero,
    details,
  };
}

function pulseCard(github: GitHubMetrics): Card {
  const { pulse, counts } = github;
  const topAgent = pulse.aiAgents[0];
  const line = (emoji: string, label: string, value: string) => clip(`${emoji} ${padEnd(label, 9)}${value}`, CARD_WIDTH);

  const hero = [
    line('🔥', 'Streak', `${pulse.streak}d now · best ${pulse.bestStreak}d · ${pulse.activeDaysYear}/365 active`),
    line('📈', 'Peak', pulse.busiest ? `${pulse.busiest.date} · ${commas(pulse.busiest.count)} in a day` : 'n/a'),
    line('🤖', 'AI pair', topAgent ? `${percent(pulse.aiShare, 0)} of commits · ${percent(pulse.aiShareRecent, 0)} last 90d` : 'no AI co-authored commits'),
    line('🔀', 'PRs', `${percent(pulse.mergeRate, 0)} merged · median ${hours(pulse.mergeHours)} to merge`),
    line('👀', 'Reviews', `${commas(counts.reviews)} PRs · median ${hours(pulse.reviewHours)} to review`),
  ];

  const details = [
    'COMMIT TYPES',
    ...(pulse.kinds.length
      ? table(pulse.kinds.map((kind) => [kind.name, commas(kind.count)]), ['l', 'r'])
      : ['No conventional-commit prefixes found.']),
    '',
    'ALSO',
    `Median commit size  ${pulse.avgCommitSize === null ? 'n/a' : `${commas(pulse.avgCommitSize)} lines`}`,
    `Stars earned        ${commas(pulse.stars)}`,
    `Followers           ${commas(pulse.followers)}`,
    `On GitHub since     ${github.memberSince.slice(0, 10)}`,
  ];

  return {
    key: 'pulse',
    title: `🔥 Pulse: ${pulse.streak}-day streak`,
    filename: 'oh-my-gist-pulse.txt',
    hero,
    details,
  };
}

export function buildCards(metrics: Metrics): Card[] {
  const cards: Card[] = [];
  if (metrics.github) {
    cards.push(
      contributionsCard(metrics.github),
      rhythmCard(metrics.github, metrics.timezone),
      languagesCard(metrics.github),
      churnCard(metrics.github),
    );
  }
  if (metrics.tokens) cards.push(tokensCard(metrics.tokens));
  if (metrics.github) cards.push(coauthorsCard(metrics.github), pulseCard(metrics.github));
  return cards;
}
