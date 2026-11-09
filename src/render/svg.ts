import type { GitHubMetrics, Metrics, TokenMetrics } from '../metrics.ts';
import { commas, compact, hours, money, percent } from '../util/format.ts';
import { WEEKDAYS } from '../util/time.ts';

/**
 * Colors come from a palette checked for color-vision safety: categorical slots
 * keep a fixed order, magnitude uses one hue, and added/removed use a blue-red
 * diverging pair. Inside an <img> an SVG follows the OS color scheme and has no
 * hover, so every value is also in the text cards, which act as the table view.
 */
const STYLE = `
  svg { --surface:#fcfcfb; --ink:#0b0b0b; --ink2:#52514e; --muted:#6f6d68; --grid:#e1e0d9; --axis:#c3c2b7; --ramp-low:#c3c2b7;
    --c1:#2a78d6; --c2:#eb6834; --c3:#1baf7a; --c4:#eda100; --add:#2a78d6; --del:#e34948;
    --h0:#f0efec; --h1:#b7d3f6; --h2:#86b6ef; --h3:#5598e7; --h4:#256abf; --h5:#104281; }
  @media (prefers-color-scheme: dark) {
    svg { --surface:#1a1a19; --ink:#f0efec; --ink2:#c3c2b7; --muted:#a3a198; --grid:#2c2c2a; --axis:#383835; --ramp-low:#5c5b55;
      --c1:#3987e5; --c2:#d95926; --c3:#199e70; --c4:#c98500; --add:#3987e5; --del:#e66767;
      --h0:#2c2c2a; --h1:#104281; --h2:#1c5cab; --h3:#2a78d6; --h4:#5598e7; --h5:#9ec5f4; }
  }
  text { font-family: system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; fill: var(--ink); }
  .surface { fill: var(--surface); stroke: var(--grid); }
  .h1 { font-size: 15px; font-weight: 600; }
  .note { font-size: 12px; fill: var(--muted); }
  .label { font-size: 13px; fill: var(--ink2); }
  .value { font-size: 12px; fill: var(--ink2); font-variant-numeric: tabular-nums; }
  .axis { font-size: 11px; fill: var(--muted); font-variant-numeric: tabular-nums; }
  .hero { font-size: 56px; font-weight: 600; }
  .tile-value { font-size: 26px; font-weight: 600; }
  .grid { stroke: var(--grid); stroke-width: 1; }
  .baseline { stroke: var(--axis); stroke-width: 1; }
`;

const WIDTH = 1000;
const MARGIN = 32;
const INNER = WIDTH - MARGIN * 2;

interface Section {
  height: number;
  body: string;
}

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] as string);
}

function n(value: number): string {
  return Number(value.toFixed(2)).toString();
}

function text(x: number, y: number, content: string, cls: string, anchor: 'start' | 'end' | 'middle' = 'start'): string {
  const attr = anchor === 'start' ? '' : ` text-anchor="${anchor}"`;
  return `<text x="${n(x)}" y="${n(y)}" class="${cls}"${attr}>${esc(content)}</text>`;
}

function title(content: string): string {
  return `<title>${esc(content)}</title>`;
}

/** A bar growing right from x: square at the baseline, rounded at its data end. */
function barRight(x: number, y: number, width: number, height: number, fill: string, tip = '', round = true): string {
  if (width <= 0) return '';
  const radius = round ? Math.min(4, width, height / 2) : 0;
  const d = `M${n(x)} ${n(y)}H${n(x + width - radius)}${radius ? `A${n(radius)} ${n(radius)} 0 0 1 ${n(x + width)} ${n(y + radius)}V${n(y + height - radius)}A${n(radius)} ${n(radius)} 0 0 1 ${n(x + width - radius)} ${n(y + height)}` : `V${n(y + height)}`}H${n(x)}Z`;
  return `<path d="${d}" fill="var(--${fill})">${tip ? title(tip) : ''}</path>`;
}

function barLeft(x: number, y: number, width: number, height: number, fill: string, tip = ''): string {
  if (width <= 0) return '';
  const radius = Math.min(4, width, height / 2);
  const d = `M${n(x)} ${n(y)}H${n(x - width + radius)}A${n(radius)} ${n(radius)} 0 0 0 ${n(x - width)} ${n(y + radius)}V${n(y + height - radius)}A${n(radius)} ${n(radius)} 0 0 0 ${n(x - width + radius)} ${n(y + height)}H${n(x)}Z`;
  return `<path d="${d}" fill="var(--${fill})">${tip ? title(tip) : ''}</path>`;
}

function barUp(x: number, baseline: number, width: number, height: number, fill: string, tip = '', round = true): string {
  if (height <= 0) return '';
  const radius = round ? Math.min(4, height, width / 2) : 0;
  const top = baseline - height;
  const d = radius
    ? `M${n(x)} ${n(baseline)}V${n(top + radius)}A${n(radius)} ${n(radius)} 0 0 1 ${n(x + radius)} ${n(top)}H${n(x + width - radius)}A${n(radius)} ${n(radius)} 0 0 1 ${n(x + width)} ${n(top + radius)}V${n(baseline)}Z`
    : `M${n(x)} ${n(baseline)}V${n(top)}H${n(x + width)}V${n(baseline)}Z`;
  return `<path d="${d}" fill="var(--${fill})">${tip ? title(tip) : ''}</path>`;
}

function legend(x: number, y: number, items: { label: string; fill: string }[]): string {
  let cursor = x;
  let out = '';
  for (const item of items) {
    out += `<rect x="${n(cursor)}" y="${n(y - 9)}" width="10" height="10" rx="2" fill="var(--${item.fill})"/>`;
    out += text(cursor + 15, y, item.label, 'note');
    cursor += 15 + item.label.length * 6.6 + 18;
  }
  return out;
}

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    if (step * magnitude >= value) return step * magnitude;
  }
  return 10 * magnitude;
}

/** Skewed activity data reads better on a square-root scale: quiet cells stay visible. */
function heatStep(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0;
  return Math.max(1, Math.ceil(Math.sqrt(value / max) * 5));
}

function miniBars(x: number, y: number, values: number[], width: number, height: number): string {
  const slot = width / values.length;
  const max = Math.max(1, ...values);
  return values
    .map((value, index) => {
      const size = value > 0 ? Math.max(2, (value / max) * height) : 0;
      const last = index === values.length - 1;
      return barUp(x + index * slot, y + height, Math.max(1, slot - 2), size, last ? 'c1' : 'ramp-low');
    })
    .join('');
}

function headerSection(github: GitHubMetrics): Section {
  const { counts, monthly } = github;
  const tiles: [string, number, number[]][] = [
    ['Commits', counts.commits, monthly.commits],
    ['Pull requests', counts.pulls, monthly.pulls],
    ['Code reviews', counts.reviews, monthly.reviews],
    ['Issues', counts.issues, monthly.issues],
  ];
  const tileWidth = 150;
  const startX = INNER - tileWidth * tiles.length - 18 * (tiles.length - 1);
  let body = text(0, 22, `@${github.login}`, 'h1');
  body += text(0, 92, commas(counts.attributed), 'hero');
  body += text(0, 118, `contributions across ${commas(github.coverage.reposWithCommits)} repos and ${github.pulse.organizations} orgs`, 'note');
  tiles.forEach(([label, value, series], index) => {
    const x = startX + index * (tileWidth + 18);
    body += text(x, 22, label, 'label');
    body += text(x, 58, commas(value), 'tile-value');
    body += miniBars(x, 72, series, tileWidth, 34);
    body += text(x, 122, '12 months', 'axis');
  });
  return { height: 132, body };
}

function rhythmSection(github: GitHubMetrics, timezone: string): Section {
  const { rhythm } = github;
  const labelWidth = 34;
  const cell = 22;
  const gap = 2;
  const max = Math.max(1, ...rhythm.punch.flat());
  let body = text(0, 14, 'When contributions happen', 'h1');
  body += text(0, 32, `${commas(rhythm.total)} timestamped events, ${timezone}`, 'note');

  const top = 54;
  rhythm.punch.forEach((row, weekday) => {
    const y = top + weekday * (cell + gap);
    body += text(0, y + 15, WEEKDAYS[weekday], 'axis');
    row.forEach((value, hour) => {
      const x = labelWidth + hour * (cell + gap);
      body += `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="3" fill="var(--h${heatStep(value, max)})">${title(`${WEEKDAYS[weekday]} ${String(hour).padStart(2, '0')}:00, ${commas(value)}`)}</rect>`;
    });
  });
  const axisY = top + 7 * (cell + gap) + 12;
  for (const hour of [0, 6, 12, 18]) {
    body += text(labelWidth + hour * (cell + gap), axisY, `${String(hour).padStart(2, '0')}:00`, 'axis');
  }

  const scaleX = labelWidth + 24 * (cell + gap) - 142;
  body += text(scaleX - 6, axisY, 'Less', 'axis', 'end');
  for (let step = 0; step <= 5; step++) {
    body += `<rect x="${scaleX + step * 18}" y="${axisY - 10}" width="16" height="11" rx="2" fill="var(--h${step})"/>`;
  }
  body += text(scaleX + 6 * 18 + 2, axisY, 'More', 'axis');

  const barX = labelWidth + 24 * (cell + gap) + 40;
  const barWidth = INNER - barX;
  const peakShare = Math.max(0.01, ...rhythm.buckets.map((bucket) => bucket.share));
  body += text(barX, 14, 'By time of day', 'h1');
  body += text(barX, 32, rhythm.persona, 'note');
  rhythm.buckets.forEach((bucket, index) => {
    const y = top + index * 42;
    body += text(barX, y + 10, `${bucket.label} ${bucket.range}`, 'label');
    body += text(barX + barWidth, y + 10, percent(bucket.share, 0), 'value', 'end');
    body += `<rect x="${barX}" y="${y + 18}" width="${barWidth}" height="8" rx="4" fill="var(--grid)"/>`;
    body += barRight(barX, y + 18, (bucket.share / peakShare) * barWidth, 8, 'c1', `${bucket.label}: ${commas(bucket.count)}`);
  });
  return { height: axisY + 6, body };
}

function languagesPanel(github: GitHubMetrics, width: number): Section {
  const rows = github.languages.filter((row) => row.lines > 0).slice(0, 10);
  const nameWidth = 122;
  const valueWidth = 48;
  const trackWidth = width - nameWidth - valueWidth;
  const maxLines = Math.max(1, ...rows.map((row) => row.lines));
  const series = [
    { key: 'personal', label: 'Personal', fill: 'c1' },
    { key: 'org', label: 'Orgs', fill: 'c2' },
    { key: 'gist', label: 'Gists', fill: 'c3' },
    { key: 'external', label: 'Other', fill: 'c4' },
  ] as const;

  let body = text(0, 14, 'Top languages', 'h1');
  body += text(0, 32, `By lines you added, of ${github.languages.length} languages traced`, 'note');
  body += legend(0, 54, series.map(({ label, fill }) => ({ label, fill })));

  rows.forEach((row, index) => {
    const y = 72 + index * 26;
    body += text(0, y + 12, row.name.length > 18 ? `${row.name.slice(0, 17)}…` : row.name, 'label');
    let x = nameWidth;
    const segments = series
      .map((item) => ({ ...item, value: row[item.key] }))
      .filter((item) => (item.value / maxLines) * trackWidth >= 1);
    segments.forEach((segment, position) => {
      const raw = (segment.value / maxLines) * trackWidth;
      const isLast = position === segments.length - 1;
      const drawn = Math.max(1, isLast ? raw : raw - 2);
      body += barRight(x, y, drawn, 14, segment.fill, `${row.name}, ${segment.label}: ${compact(segment.value)} lines`, isLast);
      x += raw;
    });
    body += text(x + 6, y + 12, percent(row.share, row.share < 0.1 ? 1 : 0), 'value');
  });
  return { height: 72 + rows.length * 26, body };
}

function coauthorsPanel(github: GitHubMetrics, width: number): Section {
  const { coauthors } = github;
  const rows = coauthors.rows.slice(0, 10);
  let body = text(0, 14, 'Top coauthored with', 'h1');
  body += text(0, 32, `${commas(coauthors.coauthored)} co-authored commits, ${percent(coauthors.soloShare, 0)} solo`, 'note');
  if (rows.length === 0) {
    body += text(0, 64, 'No co-authored commits yet.', 'label');
    return { height: 80, body };
  }
  const nameWidth = 138;
  const valueWidth = 48;
  const maxCommits = Math.max(1, ...rows.map((row) => row.commits));
  rows.forEach((row, index) => {
    const y = 72 + index * 26;
    const label = row.label.length > 20 ? `${row.label.slice(0, 19)}…` : row.label;
    body += text(0, y + 12, label, 'label');
    const size = (row.commits / maxCommits) * (width - nameWidth - valueWidth);
    body += barRight(nameWidth, y, Math.max(2, size), 14, 'c1', `${row.label}: ${commas(row.commits)} commits`);
    body += text(nameWidth + Math.max(2, size) + 6, y + 12, compact(row.commits), 'value');
  });
  return { height: 72 + rows.length * 26, body };
}

function churnSection(github: GitHubMetrics): Section {
  const { churn } = github;
  const rows = churn.rows.slice(0, 10);
  const nameWidth = 130;
  const tipSpace = 58;
  // One scale for both directions; each arm gets only the width its data needs.
  const maxDel = Math.max(0, ...rows.map((row) => row.del));
  const maxAdd = Math.max(1, ...rows.map((row) => row.add));
  const pixelsPerLine = (INNER - nameWidth - tipSpace * 2) / (maxDel + maxAdd);
  const center = nameWidth + tipSpace + maxDel * pixelsPerLine;

  let body = text(0, 14, 'Lines added and removed, by language', 'h1');
  body += text(0, 32, `+${compact(churn.add)} / -${compact(churn.del)} lines of code in ${commas(github.coverage.churnDone)} commits`, 'note');
  body += legend(0, 54, [
    { label: 'Removed', fill: 'del' },
    { label: 'Added', fill: 'add' },
  ]);

  const top = 70;
  const rowHeight = 25;
  rows.forEach((row, index) => {
    const y = top + index * rowHeight;
    body += text(0, y + 12, row.name.length > 18 ? `${row.name.slice(0, 17)}…` : row.name, 'label');
    const left = row.del > 0 ? Math.max(2, row.del * pixelsPerLine) : 0;
    const right = row.add > 0 ? Math.max(2, row.add * pixelsPerLine) : 0;
    body += barLeft(center - 1, y, left, 14, 'del', `${row.name} removed: ${commas(row.del)}`);
    body += barRight(center + 1, y, right, 14, 'add', `${row.name} added: ${commas(row.add)}`);
    body += text(center - left - 7, y + 12, `-${compact(row.del)}`, 'value', 'end');
    body += text(center + right + 7, y + 12, `+${compact(row.add)}`, 'value');
  });
  const bottom = top + rows.length * rowHeight;
  body += `<line x1="${n(center)}" x2="${n(center)}" y1="${top - 4}" y2="${bottom - 6}" class="baseline"/>`;
  return { height: bottom, body };
}

function tokensSection(tokens: TokenMetrics): Section {
  const tileItems: [string, string][] = [
    ['Total tokens', compact(tokens.total)],
    ['Uncached', compact(tokens.fresh)],
    ['Output', compact(tokens.output)],
    ['Cache hit rate', percent(tokens.cacheShare, 1)],
    ['At API list price', `${tokens.unpricedModels.length ? '≥' : '≈'}${money(tokens.cost)}`],
  ];
  let body = text(0, 14, 'AI token trace', 'h1');
  body += text(0, 32, `${commas(tokens.messages)} model responses since ${tokens.firstDay}, from local Claude Code and Codex logs`, 'note');
  const tileWidth = INNER / tileItems.length;
  tileItems.forEach(([label, value], index) => {
    body += text(index * tileWidth, 66, value, 'tile-value');
    body += text(index * tileWidth, 86, label, 'label');
  });

  // Fixed per tool, so a tool keeps its color when the ranking changes.
  const TOOL_FILLS: Record<string, string> = { claude: 'c1', codex: 'c2' };
  const spare = ['c3', 'c4'];
  const toolNames = tokens.tools.map((tool) => tool.tool).sort();
  const fillOf = (tool: string) => TOOL_FILLS[tool] ?? spare[Math.max(0, toolNames.indexOf(tool)) % spare.length];
  const toolLabel: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' };
  body += text(0, 120, 'Tokens per day, last 60 days', 'label');
  body += legend(
    INNER - toolNames.length * 110,
    120,
    toolNames.map((tool) => ({ label: toolLabel[tool] ?? tool, fill: fillOf(tool) })),
  );

  const axisWidth = 44;
  const plotTop = 134;
  const plotHeight = 120;
  const baseline = plotTop + plotHeight;
  const plotWidth = INNER - axisWidth;
  const peak = niceMax(Math.max(1, ...tokens.daily.map((day) => day.total)));
  for (const tick of [0, 0.5, 1]) {
    const y = baseline - tick * plotHeight;
    body += `<line x1="${axisWidth}" x2="${INNER}" y1="${n(y)}" y2="${n(y)}" class="${tick === 0 ? 'baseline' : 'grid'}"/>`;
    body += text(axisWidth - 8, y + 4, compact(peak * tick), 'axis', 'end');
  }
  const slot = plotWidth / tokens.daily.length;
  tokens.daily.forEach((day, index) => {
    const x = axisWidth + index * slot;
    const parts = toolNames
      .map((tool) => ({ tool, fill: fillOf(tool), value: day.byTool[tool] ?? 0 }))
      .filter((part) => part.value > 0);
    let stack = 0;
    parts.forEach((part, position) => {
      const raw = (part.value / peak) * plotHeight;
      const isTop = position === parts.length - 1;
      const drawn = Math.max(1, isTop ? raw : raw - 2);
      body += barUp(x + 1, baseline - stack, slot - 2, drawn, part.fill, `${day.date}, ${toolLabel[part.tool] ?? part.tool}: ${compact(part.value)}`, isTop);
      stack += raw;
    });
  });
  const labelled = [0, Math.floor(tokens.daily.length / 2), tokens.daily.length - 1];
  labelled.forEach((index) => {
    const anchor = index === 0 ? 'start' : index === tokens.daily.length - 1 ? 'end' : 'middle';
    const x = axisWidth + index * slot + (index === tokens.daily.length - 1 ? slot : 0);
    body += text(x, baseline + 16, tokens.daily[index].date.slice(5), 'axis', anchor);
  });
  return { height: baseline + 22, body };
}

function historySection(github: GitHubMetrics): Section {
  const grid = github.yearGrid.slice(0, 8);
  const cellWidth = 30;
  const cellHeight = 18;
  const gap = 2;
  const labelWidth = 40;
  const max = Math.max(1, ...grid.flatMap((row) => row.months));

  let body = text(0, 14, 'Every year, by month', 'h1');
  body += text(0, 32, 'Commits, PRs, issues and reviews', 'note');
  const top = 48;
  'JFMAMJJASOND'.split('').forEach((letter, index) => {
    body += text(labelWidth + index * (cellWidth + gap) + cellWidth / 2, top, letter, 'axis', 'middle');
  });
  grid.forEach((row, rowIndex) => {
    const y = top + 8 + rowIndex * (cellHeight + gap);
    body += text(0, y + 13, String(row.year), 'axis');
    row.months.forEach((value, month) => {
      const x = labelWidth + month * (cellWidth + gap);
      body += `<rect x="${x}" y="${y}" width="${cellWidth}" height="${cellHeight}" rx="3" fill="var(--h${heatStep(value, max)})">${title(`${row.year}-${String(month + 1).padStart(2, '0')}: ${commas(value)}`)}</rect>`;
    });
  });
  const gridBottom = top + 8 + grid.length * (cellHeight + gap);

  const { pulse } = github;
  const tiles: [string, string][] = [
    ['Current streak', `${pulse.streak}d`],
    ['Best streak', `${pulse.bestStreak}d`],
    ['Active days, 1 year', commas(pulse.activeDaysYear)],
    ['PRs merged', percent(pulse.mergeRate, 0)],
    ['Median time to merge', hours(pulse.mergeHours)],
    ['Median time to review', hours(pulse.reviewHours)],
  ];
  const tilesX = labelWidth + 12 * (cellWidth + gap) + 44;
  const tileWidth = (INNER - tilesX) / 3;
  tiles.forEach(([label, value], index) => {
    const x = tilesX + (index % 3) * tileWidth;
    const y = Math.floor(index / 3) * 72;
    body += text(x, y + 30, value, 'tile-value');
    body += text(x, y + 50, label, 'note');
  });
  return { height: Math.max(gridBottom, 144), body };
}

export function renderDashboard(metrics: Metrics): string {
  const sections: Section[] = [];
  const { github, tokens } = metrics;

  if (github) {
    sections.push(headerSection(github), rhythmSection(github, metrics.timezone));
    const panelGap = 48;
    const leftWidth = Math.round((INNER - panelGap) * 0.58);
    const left = languagesPanel(github, leftWidth);
    const right = coauthorsPanel(github, INNER - panelGap - leftWidth);
    sections.push({
      height: Math.max(left.height, right.height),
      body: `${left.body}<g transform="translate(${leftWidth + panelGap} 0)">${right.body}</g>`,
    });
    sections.push(churnSection(github));
  }
  if (tokens) sections.push(tokensSection(tokens));
  if (github) sections.push(historySection(github));

  const spacing = 36;
  let y = MARGIN;
  let content = '';
  sections.forEach((section, index) => {
    if (index > 0) {
      content += `<line x1="${MARGIN}" x2="${WIDTH - MARGIN}" y1="${y - spacing / 2}" y2="${y - spacing / 2}" class="grid"/>`;
    }
    content += `<g transform="translate(${MARGIN} ${y})">${section.body}</g>`;
    y += section.height + spacing;
  });
  const height = y - spacing + MARGIN + 18;
  content += text(MARGIN, height - 20, `oh-my-gist · updated ${metrics.generatedDate} · ${metrics.timezone}`, 'axis');

  const summary = github
    ? `${github.login}: ${commas(github.counts.commits)} commits, ${commas(github.counts.pulls)} pull requests, ${commas(github.counts.reviews)} reviews, ${commas(github.counts.issues)} issues.`
    : tokens
      ? `AI token usage: ${compact(tokens.total)} tokens.`
      : 'No data yet.';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${n(height)}" width="${WIDTH}" height="${n(height)}" role="img" aria-labelledby="omg-title omg-desc">
<title id="omg-title">oh-my-gist developer dashboard</title>
<desc id="omg-desc">${esc(summary)}</desc>
<style>${STYLE}</style>
<rect x="0.5" y="0.5" width="${WIDTH - 1}" height="${n(height - 1)}" rx="12" class="surface"/>
${content}
</svg>
`;
}
