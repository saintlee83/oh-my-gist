import { CARD_LINES, cardContent, type Card } from './cards.ts';

export const HUB_FILE = '00-oh-my-gist.md';
export const DASHBOARD_FILE = 'dashboard.svg';
export const LEDGER_FILE = 'tokens-ledger.json';

export interface HubLinks {
  /** Card key -> gist URL */
  cards: Record<string, string>;
  dashboardUrl: string | null;
}

/** Full report in one gist. It holds the dashboard SVG and links to each card. */
export function renderHub(login: string | null, cards: Card[], date: string, links: HubLinks): string {
  const out: string[] = [`# ${login ? `@${login}` : 'Developer profile'}, by the numbers`, ''];
  if (links.dashboardUrl) out.push(`![Developer dashboard](${links.dashboardUrl})`, '');

  for (const card of cards) {
    const url = links.cards[card.key];
    out.push(`## ${url ? `[${card.title}](${url})` : card.title}`, '', '```text');
    out.push(cardContent(card, date).trimEnd().split('\n').slice(0, -2).join('\n').trimEnd());
    out.push('```', '');
  }

  out.push(
    '---',
    '',
    `Updated ${date} with [oh-my-gist](https://github.com/saintlee83/oh-my-gist). Aggregated counts only:`,
    'no private repository, organization or file names are published.',
    '',
  );
  return out.join('\n');
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char] as string);
}

/**
 * Local preview using the sizes GitHub uses for pinned gists: a 440px card with
 * 11px text, five lines, and overflow clipped. Clipping here means clipping there.
 */
export function renderPreview(cards: Card[], svg: string): string {
  const pins = cards
    .map((card) => {
      const lines = card.hero
        .slice(0, CARD_LINES)
        .map((line, index) => `<div class="line"><span class="num">${index + 1}</span><pre>${escapeHtml(line)}</pre></div>`)
        .join('');
      return `<article class="pin"><h3>${escapeHtml(card.title)}</h3><div class="blob">${lines}</div></article>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>oh-my-gist preview</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#1f2328; --link:#0969da; --line:#d1d9e0; --blob:#f6f8fa; --num:#636c76; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0d1117; --fg:#e6edf3; --link:#4493f8; --line:#3d444d; --blob:#151b23; --num:#8b949e; } }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px 16px; background: var(--bg); color: var(--fg); font: 14px/1.5 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; }
  main { max-width: 896px; margin: 0 auto; }
  h2 { font-size: 16px; font-weight: 400; margin: 0 0 8px; }
  .pins { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 440px), 1fr)); gap: 16px; margin-bottom: 32px; }
  .pin { border: 1px solid var(--line); border-radius: 6px; padding: 16px; min-width: 0; }
  .pin h3 { margin: 0 0 16px; font-size: 14px; font-weight: 600; color: var(--link); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .blob { background: var(--blob); border-radius: 0 0 6px 6px; padding: 8px 16px 4px 0; }
  .line { display: flex; align-items: center; }
  .num { width: 28px; flex: none; padding-right: 8px; text-align: right; color: var(--num); font: 11px/1.25 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  pre { margin: 0; min-width: 0; overflow: hidden; font: 11px/1.25 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .dash { max-width: 100%; height: auto; display: block; }
</style>
</head>
<body>
<main>
<h2>Pinned</h2>
<section class="pins">
${pins}
</section>
<h2>Dashboard</h2>
<img class="dash" alt="Developer dashboard" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}">
</main>
</body>
</html>
`;
}
