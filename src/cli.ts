#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig, type Config } from './config.ts';
import { GitHubClient, redactQuoted, resolveToken } from './github/client.ts';
import { collectGitHub } from './github/collect.ts';
import {
  assertCreationAllowed,
  ConfirmationRequired,
  fetchRemoteLedger,
  findGist,
  listGists,
  publishSpec,
  type GistSpec,
  type PublishOptions,
  type PublishResult,
} from './github/gists.ts';
import { computeMetrics, type Metrics } from './metrics.ts';
import { buildCards, cardContent, type Card } from './render/cards.ts';
import { DASHBOARD_FILE, HUB_FILE, LEDGER_FILE, renderHub, renderPreview, type HubLinks } from './render/report.ts';
import { renderDashboard } from './render/svg.ts';
import { collectTokens, defaultLogRoots, discoverLogs, loadLedger, mergeLedgers, serializeLedger } from './tokens/ledger.ts';
import { loadPrices } from './tokens/pricing.ts';
import { collectToolTotals, readClaudeStats, readCodexAccount } from './tokens/totals.ts';
import type { Snapshot, TokenLedger } from './types.ts';

const USAGE = `oh-my-gist: the ultimate pinned-gist profile

Usage: node src/cli.ts <command> [options]

Commands:
  doctor             Check token, org access, and AI log sources
  collect            Fetch GitHub data and scan local AI logs
  render             Write cards, dashboard and preview to out/
  publish            Create or update the gists
  run                collect + render + publish
  schedule           Run automatically on this machine (--install, --uninstall)

Options:
  --github-only      Skip local AI logs (for CI; reuses the published ledger)
  --tokens-only      Only the token card (fast; no GitHub collection)
  --dry-run          Show what publish would do without writing
  --yes              Allow creating new public gists
  --update-only      Only update gists that exist; a deleted card stays deleted
  -h, --help         Show this help
`;

const log = (message: string) => console.error(`  ${message}`);

function snapshotPath(config: Config) {
  return join(config.home, 'snapshot.json');
}

function ledgerPath(config: Config) {
  return join(config.home, 'token-ledger.json');
}

function loadSnapshot(config: Config): Snapshot | null {
  const path = snapshotPath(config);
  if (!existsSync(path)) return null;
  const snapshot = JSON.parse(readFileSync(path, 'utf8')) as Snapshot;
  return snapshot.version === 1 ? snapshot : null;
}

function makeClient(): { client: GitHubClient; source: string } {
  const { token, source } = resolveToken();
  // OMG_API_URL points at GitHub Enterprise, or a local server in tests.
  return { client: new GitHubClient(token, { baseUrl: process.env.OMG_API_URL || undefined }), source };
}

interface Flags {
  githubOnly: boolean;
  tokensOnly: boolean;
  dryRun: boolean;
  yes: boolean;
  updateOnly: boolean;
  install: boolean;
  uninstall: boolean;
}

async function collect(config: Config, flags: Flags): Promise<void> {
  if (!flags.tokensOnly) {
    console.error('Collecting GitHub data');
    const { client } = makeClient();
    const snapshot = await collectGitHub(client, config, log);
    writeFileSync(snapshotPath(config), JSON.stringify(snapshot));
    const { coverage, commits, pulls, reviews, issues } = snapshot;
    log(
      `done: ${commits.length} commits, ${pulls.length} PRs, ${reviews.length} reviews, ${issues.length} issues` +
        ` in ${coverage.reposWithCommits}/${coverage.reposListed} repos` +
        (coverage.reposFailed ? ` (${coverage.reposFailed} repos failed)` : ''),
    );
  }
  if (!flags.githubOnly) {
    console.error('Scanning AI usage logs');
    const totals = await collectToolTotals(log);
    const { scan } = await collectTokens(defaultLogRoots(), config.home, config.timezone, log, totals);
    log(`done: ${scan.events.length} model responses from ${scan.files} log files${scan.failed ? ` (${scan.failed} unreadable)` : ''}`);
  }
}

async function buildMetrics(config: Config, ledger: TokenLedger | null, now = new Date()): Promise<Metrics> {
  const prices = ledger ? await loadPrices(config.home) : {};
  return computeMetrics(loadSnapshot(config), ledger, prices, config.timezone, now, {
    maxCommitLines: config.churn.maxCommitLines,
    excludeLanguages: config.excludeLanguages,
  });
}

function writeOutputs(config: Config, metrics: Metrics, cards: Card[], ledger: TokenLedger | null): void {
  mkdirSync(join(config.outDir, 'cards'), { recursive: true });
  const svg = renderDashboard(metrics);
  for (const card of cards) {
    writeFileSync(join(config.outDir, 'cards', card.filename), cardContent(card, metrics.generatedDate));
  }
  writeFileSync(join(config.outDir, DASHBOARD_FILE), svg);
  writeFileSync(join(config.outDir, 'preview.html'), renderPreview(cards, svg));
  writeFileSync(
    join(config.outDir, HUB_FILE),
    renderHub(metrics.github?.login ?? null, cards, metrics.generatedDate, { cards: {}, dashboardUrl: null }),
  );
  if (ledger) writeFileSync(join(config.outDir, LEDGER_FILE), serializeLedger(ledger));
}

async function render(config: Config): Promise<void> {
  const ledger = existsSync(ledgerPath(config)) ? loadLedger(ledgerPath(config)) : null;
  const metrics = await buildMetrics(config, ledger);
  if (!metrics.github && !metrics.tokens) throw new Error('Nothing to render yet. Run `collect` first.');
  const cards = buildCards(metrics);
  writeOutputs(config, metrics, cards, ledger);
  console.error(`Wrote ${cards.length} cards and a dashboard to ${config.outDir}`);
  console.error(`Preview: ${join(config.outDir, 'preview.html')}`);
}

function cardSpec(card: Card, date: string, ledger: TokenLedger | null): GistSpec {
  const files: Record<string, string> = { [card.filename]: cardContent(card, date) };
  // GitHub pins the alphabetically first file, which stays the card itself.
  if (card.key === 'tokens' && ledger) files[LEDGER_FILE] = serializeLedger(ledger);
  return { key: card.key, description: card.title, primaryFile: card.filename, files };
}

function describe(result: PublishResult, spec: GistSpec): string {
  return `${result.action.padEnd(12)} ${spec.description}${result.url ? `  ${result.url}` : ''}`;
}

async function publish(config: Config, flags: Flags): Promise<void> {
  const { client } = makeClient();
  const gists = await listGists(client);
  client.assertScopes(['gist']);

  // The published ledger backs up history and feeds CI runs, which have no local logs.
  const tokenFile = 'oh-my-gist-tokens.txt';
  const remote = await fetchRemoteLedger(client, gists, LEDGER_FILE);
  const local = !flags.githubOnly && existsSync(ledgerPath(config)) ? loadLedger(ledgerPath(config)) : null;
  const ledger = remote && local ? mergeLedgers(remote, local) : (local ?? remote);
  if (ledger && local && !flags.dryRun) writeFileSync(ledgerPath(config), serializeLedger(ledger));

  const metrics = await buildMetrics(config, ledger);
  if (!metrics.github && !metrics.tokens) throw new Error('Nothing to publish yet. Run `collect` first.');
  const date = metrics.generatedDate;
  const allCards = buildCards(metrics);
  writeOutputs(config, metrics, allCards, ledger);

  const includeCard = (card: Card) => {
    if (flags.tokensOnly) return card.filename === tokenFile;
    if (flags.githubOnly) return card.filename !== tokenFile;
    return true;
  };
  const wanted = (primaryFile: string) => !flags.updateOnly || findGist(gists, primaryFile) !== null;
  const specs = allCards
    .filter(includeCard)
    .map((card) => cardSpec(card, date, ledger))
    .filter((spec) => wanted(spec.primaryFile));
  const includeHub = !flags.tokensOnly && Boolean(metrics.github) && wanted(HUB_FILE);
  if (specs.length === 0 && !includeHub) {
    console.error('No gists to update yet. Run `publish --yes` once to create them.');
    return;
  }
  const hubDescription = metrics.github ? `@${metrics.github.login}, by the numbers` : 'Developer profile';
  const svg = renderDashboard(metrics);
  const hubSpec = (links: HubLinks): GistSpec => ({
    key: 'hub',
    description: hubDescription,
    primaryFile: HUB_FILE,
    files: {
      [HUB_FILE]: renderHub(metrics.github?.login ?? null, allCards, date, links),
      [DASHBOARD_FILE]: svg,
    },
  });
  const firstHub = hubSpec({ cards: {}, dashboardUrl: null });

  const options: PublishOptions = { public: config.public, confirmed: flags.yes, dryRun: flags.dryRun };
  assertCreationAllowed(includeHub ? [...specs, firstHub] : specs, gists, options);

  const links: HubLinks = { cards: {}, dashboardUrl: null };
  for (const card of allCards) {
    const known = findGist(gists, card.filename);
    if (known) links.cards[card.key] = known.html_url;
  }
  console.error(flags.dryRun ? 'Dry run: nothing will be written' : 'Publishing');
  for (const spec of specs) {
    const result = await publishSpec(client, spec, findGist(gists, spec.primaryFile), options);
    if (result.url) links.cards[spec.key] = result.url;
    console.error(`  ${describe(result, spec)}`);
  }

  if (includeHub) {
    let hub = findGist(gists, HUB_FILE);
    if (!hub && !flags.dryRun) {
      // The dashboard's URL contains the gist ID, so the gist has to exist first.
      const created = await publishSpec(client, firstHub, null, options);
      hub = { id: created.id as string, html_url: created.url as string, files: { [HUB_FILE]: { filename: HUB_FILE } } };
    }
    if (hub && metrics.github) {
      links.dashboardUrl = `https://gist.githubusercontent.com/${metrics.github.login}/${hub.id}/raw/${DASHBOARD_FILE}`;
    }
    const finalHub = hubSpec(links);
    const result = await publishSpec(client, finalHub, hub, options);
    console.error(`  ${describe(result, finalHub)}`);
    if (links.dashboardUrl && !flags.dryRun) {
      console.error(`\nEmbed the dashboard in your profile README:\n  ![Dashboard](${links.dashboardUrl})`);
    }
  }
  if (!flags.dryRun && !flags.updateOnly) {
    console.error(`\nPin cards at https://github.com/${metrics.github?.login ?? ''} > Customize your pins (GitHub allows 6).`);
  }
}

async function doctor(config: Config): Promise<void> {
  const { client, source } = makeClient();
  const data = await client.graphql<{
    viewer: {
      login: string;
      organizations: { nodes: { login: string; repositories: { totalCount: number } }[] };
      contributionsCollection: { restrictedContributionsCount: number; contributionCalendar: { totalContributions: number } };
    };
    rateLimit: { remaining: number; limit: number };
  }>(`query {
    viewer {
      login
      organizations(first: 100) { nodes { login repositories { totalCount } } }
      contributionsCollection { restrictedContributionsCount contributionCalendar { totalContributions } }
    }
    rateLimit { remaining limit }
  }`);
  await client.rest('/rate_limit');

  const { viewer, rateLimit } = data;
  console.log(`Account    @${viewer.login} (token from ${source})`);
  console.log(`Timezone   ${config.timezone}`);
  console.log(`State      ${config.home}`);
  console.log(`GraphQL    ${rateLimit.remaining}/${rateLimit.limit} points left`);

  const scopes = (client.scopes ?? '').split(',').map((scope) => scope.trim()).filter(Boolean);
  const missing = ['repo', 'read:org', 'gist'].filter((scope) => !scopes.includes(scope));
  if (client.scopes === null) console.log('Scopes     not reported (fine-grained token); check it can read repos and write gists');
  else console.log(`Scopes     ${scopes.join(', ')}${missing.length ? `  MISSING: ${missing.join(', ')}` : '  OK'}`);

  const { contributionCalendar, restrictedContributionsCount } = viewer.contributionsCollection;
  console.log(`\nLast year  ${contributionCalendar.totalContributions} contributions on your graph, ${restrictedContributionsCount} hidden from the API breakdown.`);
  if (restrictedContributionsCount > 0) console.log('           oh-my-gist recovers these by walking each repository directly.');

  console.log(`\nOrganizations (${viewer.organizations.nodes.length})`);
  for (const org of viewer.organizations.nodes) {
    console.log(`  ${org.login.padEnd(28)} ${String(org.repositories.totalCount).padStart(4)} repos visible`);
  }
  console.log('  An org showing fewer repos than expected may restrict OAuth apps:');
  console.log('  https://github.com/settings/connections/applications/178c6fc778ccc68e1d6a');

  const logs = await discoverLogs(defaultLogRoots());
  const describeLogs = (tool: string) => {
    const files = logs.filter((file) => file.tool === tool);
    const total = files.reduce((sum, file) => sum + file.size, 0);
    return `${files.length} files, ${(total / 1e6).toFixed(0)} MB`;
  };
  console.log(`\nAI logs    Claude Code: ${describeLogs('claude')}`);
  console.log(`           Codex:       ${describeLogs('codex')}`);

  const claudeStats = readClaudeStats();
  const codexAccount = await readCodexAccount();
  const figure = (total: number | undefined) => (total ? `${(total / 1e9).toFixed(2)}B tokens` : 'unavailable, so logs are used');
  console.log(`\nLifetime   Claude Code statistics: ${figure(claudeStats?.total)}`);
  console.log(`           Codex account:          ${figure(codexAccount?.total)}`);
}

const PLIST_LABEL = 'dev.oh-my-gist.refresh';

function schedule(config: Config, flags: Flags): void {
  const cli = fileURLToPath(import.meta.url);
  if (platform() !== 'darwin') {
    console.log('Add this to your crontab (crontab -e) to refresh every 6 hours:');
    // Cron starts with a minimal PATH, which usually lacks `gh`.
    console.log(`0 */6 * * * PATH="${process.env.PATH}" "${process.execPath}" "${cli}" run --update-only >> "${join(config.home, 'schedule.log')}" 2>&1`);
    return;
  }
  const plist = join(homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);
  const target = `gui/${process.getuid?.() ?? 501}`;
  if (flags.uninstall) {
    if (existsSync(plist)) {
      try {
        execFileSync('launchctl', ['bootout', target, plist], { stdio: 'ignore' });
      } catch {
        // Not loaded.
      }
      rmSync(plist);
    }
    console.log('Removed the schedule.');
    return;
  }
  if (!flags.install) {
    console.log(`Refreshes every 6 hours and on wake, using launchd.\nInstall with: node src/cli.ts schedule --install\nAgent file:   ${plist}`);
    return;
  }
  const logFile = join(config.home, 'schedule.log');
  // Keep the installer's PATH: launchd's own lacks `gh` and `codex`.
  const path = [dirname(process.execPath), process.env.PATH, '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'].filter(Boolean).join(':').replace(/&/g, '&amp;').replace(/</g, '&lt;');
  // A scheduled job never creates public gists, and a deleted card stays deleted.
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${cli}</string>
    <string>run</string>
    <string>--update-only</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${path}</string></dict>
  <key>StartInterval</key><integer>21600</integer>
  <key>StandardOutPath</key><string>${logFile}</string>
  <key>StandardErrorPath</key><string>${logFile}</string>
</dict>
</plist>
`;
  mkdirSync(dirname(plist), { recursive: true });
  writeFileSync(plist, xml);
  try {
    execFileSync('launchctl', ['bootout', target, plist], { stdio: 'ignore' });
  } catch {
    // Not loaded yet.
  }
  execFileSync('launchctl', ['bootstrap', target, plist]);
  console.log(`Scheduled every 6 hours. Logs: ${logFile}`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'github-only': { type: 'boolean', default: false },
      'tokens-only': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      'update-only': { type: 'boolean', default: false },
      install: { type: 'boolean', default: false },
      uninstall: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const command = positionals[0];
  if (values.help || !command) {
    console.log(USAGE);
    return;
  }
  const flags: Flags = {
    githubOnly: values['github-only'],
    tokensOnly: values['tokens-only'],
    dryRun: values['dry-run'],
    yes: values.yes,
    updateOnly: values['update-only'],
    install: values.install,
    uninstall: values.uninstall,
  };
  if (flags.githubOnly && flags.tokensOnly) throw new Error('--github-only and --tokens-only cannot be combined.');
  if (flags.yes && flags.updateOnly) throw new Error('--yes and --update-only cannot be combined.');

  const config = loadConfig();
  switch (command) {
    case 'doctor':
      return doctor(config);
    case 'collect':
      return collect(config, flags);
    case 'render':
      return render(config);
    case 'publish':
      return publish(config, flags);
    case 'run':
      await collect(config, flags);
      return publish(config, flags);
    case 'schedule':
      return schedule(config, flags);
    default:
      throw new Error(`Unknown command "${command}".\n\n${USAGE}`);
  }
}

main().catch((error: unknown) => {
  if (error instanceof ConfirmationRequired) {
    console.error('These public gists would be created:');
    for (const spec of error.specs) console.error(`  ${spec.description}`);
    console.error('\nNothing was published. Review out/preview.html, then re-run with --yes.');
  } else {
    const message = error instanceof Error ? error.message : String(error);
    console.error(process.env.CI ? redactQuoted(message) : message);
  }
  process.exitCode = 1;
});
