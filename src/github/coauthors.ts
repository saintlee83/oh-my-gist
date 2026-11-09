import type { CoauthorRow, CoauthorSummary } from '../types.ts';
import { aiCoauthor } from './classify.ts';

export interface GitActor {
  name: string | null;
  email: string | null;
  user: { login: string } | null;
}

/** Internal to collection: identities here must not reach the Snapshot unfiltered. */
export interface CoauthorEvent {
  oid: string;
  isPrivate: boolean;
  /** As returned by `Commit.authors`: the git author first, then trailer co-authors. */
  actors: GitActor[];
}

function isBot(actor: GitActor): boolean {
  return /\[bot\]/i.test(`${actor.name ?? ''} ${actor.user?.login ?? ''} ${actor.email ?? ''}`);
}

function botName(actor: GitActor): string {
  return (actor.user?.login ?? actor.name ?? 'bot').replace(/\[bot\]/i, '').trim() || 'bot';
}

/** "Claude Opus 5 (1M context)" -> "Claude Opus 5", so a model keeps one row. */
export function aiLabel(name: string, family: string): string {
  const clean = name.replace(/\s*\([^)]*\)\s*$/, '').trim();
  return clean.toLowerCase().startsWith(family.toLowerCase()) && clean.length <= 24 ? clean : family;
}

/**
 * Applies the publishing rule for co-authors:
 * - AI assistants and bots are named, because they are not people.
 * - A person is named only with a GitHub account and a co-authored commit in a
 *   public repo. That link is already public, and only those commits are counted,
 *   so the number reveals nothing about private work.
 * - `allowed` logins opt in explicitly, and count everywhere.
 * - `agents` logins are your own AI agent accounts: named and counted as AI.
 * - All other collaboration is an anonymous count. Emails are never kept.
 */
export function tallyCoauthors(
  events: CoauthorEvent[],
  login: string,
  totalCommits: number,
  allowed: string[] = [],
  agents: string[] = [],
): CoauthorSummary {
  const named = new Map<string, CoauthorRow>();
  const privatePeople = new Set<string>();
  const seen = new Set<string>();
  const optedIn = new Set(allowed.map((name) => name.toLowerCase()));
  const agentAccounts = new Set(agents.map((name) => name.toLowerCase()));
  const self = login.toLowerCase();
  const byKind = { ai: 0, bot: 0, person: 0 };
  let privateCommits = 0;
  let coauthoredCommits = 0;

  for (const event of events) {
    if (seen.has(event.oid)) continue;
    seen.add(event.oid);

    const author = event.actors[0];
    const authorEmail = author?.email?.toLowerCase();
    const credited = new Set<string>();
    const kinds = new Set<keyof typeof byKind>();
    let hasPrivatePerson = false;
    let hasCoauthor = false;

    const credit = (key: string, label: string, kind: CoauthorRow['kind']) => {
      kinds.add(kind);
      if (credited.has(key)) return;
      credited.add(key);
      const row = named.get(key) ?? { label, kind, commits: 0 };
      row.commits++;
      named.set(key, row);
    };

    for (const actor of event.actors.slice(1)) {
      const account = actor.user?.login ?? null;
      const email = actor.email?.toLowerCase() ?? '';
      // A trailer can credit the author again under a second address.
      if (account?.toLowerCase() === self || (email && email === authorEmail)) continue;
      hasCoauthor = true;

      const family = aiCoauthor(actor.name ?? '', email, account);
      if (account && agentAccounts.has(account.toLowerCase())) {
        credit(`ai:@${account}`, `@${account}`, 'ai');
      } else if (family) {
        const label = aiLabel(actor.name ?? '', family);
        credit(`ai:${label}`, label, 'ai');
      } else if (isBot(actor)) {
        const name = botName(actor);
        credit(`bot:${name}`, name, 'bot');
      } else if (account && (!event.isPrivate || optedIn.has(account.toLowerCase()))) {
        credit(`person:${account}`, `@${account}`, 'person');
      } else {
        const identity = account?.toLowerCase() ?? (email || (actor.name ?? '').toLowerCase());
        if (identity) privatePeople.add(identity);
        hasPrivatePerson = true;
        kinds.add('person');
      }
    }

    for (const kind of kinds) byKind[kind]++;
    if (hasPrivatePerson) privateCommits++;
    if (hasCoauthor) coauthoredCommits++;
  }

  return {
    named: [...named.values()].sort((a, b) => b.commits - a.commits || a.label.localeCompare(b.label)),
    privatePeople: privatePeople.size,
    privateCommits,
    coauthoredCommits,
    soloCommits: Math.max(0, totalCommits - coauthoredCommits),
    byKind,
  };
}
