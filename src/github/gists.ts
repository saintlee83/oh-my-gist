import type { TokenLedger } from '../types.ts';
import { GitHubClient, GitHubError } from './client.ts';

export interface GistSpec {
  key: string;
  description: string;
  /** Found by this filename, so no gist IDs need to be stored anywhere. */
  primaryFile: string;
  files: Record<string, string>;
}

export interface RemoteGist {
  id: string;
  html_url: string;
  files: Record<string, { filename: string }>;
}

interface FullGist extends RemoteGist {
  description: string | null;
  owner?: { login: string };
  files: Record<string, { filename: string; content?: string; truncated?: boolean; raw_url?: string }>;
}

export type PublishAction = 'created' | 'updated' | 'unchanged' | 'would-create' | 'would-update';

export interface PublishResult {
  key: string;
  action: PublishAction;
  id: string | null;
  url: string | null;
}

export class ConfirmationRequired extends Error {
  specs: GistSpec[];
  constructor(specs: GistSpec[]) {
    super(`${specs.length} new public gists would be created.`);
    this.name = 'ConfirmationRequired';
    this.specs = specs;
  }
}

export async function listGists(client: GitHubClient): Promise<RemoteGist[]> {
  const out: RemoteGist[] = [];
  for (let page = 1; ; page++) {
    const batch = await client.rest<RemoteGist[]>(`/gists?per_page=100&page=${page}`);
    out.push(...batch);
    if (batch.length < 100) return out;
  }
}

export function findGist(gists: RemoteGist[], filename: string): RemoteGist | null {
  return gists.find((gist) => filename in gist.files) ?? null;
}

async function fileContent(file: FullGist['files'][string]): Promise<string | null> {
  if (!file.truncated) return file.content ?? null;
  if (!file.raw_url) return null;
  const response = await fetch(file.raw_url);
  return response.ok ? response.text() : null;
}

/** Publishing without changes would add a revision to the gist history on every run. */
async function isUnchanged(client: GitHubClient, id: string, spec: GistSpec): Promise<boolean> {
  const current = await client.rest<FullGist>(`/gists/${id}`);
  if ((current.description ?? '') !== spec.description) return false;
  for (const [name, content] of Object.entries(spec.files)) {
    const file = current.files[name];
    if (!file) return false;
    if ((await fileContent(file)) !== content) return false;
  }
  return true;
}

function toFilesPayload(files: Record<string, string>) {
  return Object.fromEntries(Object.entries(files).map(([name, content]) => [name, { content }]));
}

export interface PublishOptions {
  public: boolean;
  /** Creating public gists needs consent. Updating gists this tool already owns does not. */
  confirmed: boolean;
  dryRun: boolean;
}

export async function publishSpec(
  client: GitHubClient,
  spec: GistSpec,
  existing: RemoteGist | null,
  options: PublishOptions,
): Promise<PublishResult> {
  if (existing) {
    if (await isUnchanged(client, existing.id, spec)) {
      return { key: spec.key, action: 'unchanged', id: existing.id, url: existing.html_url };
    }
    if (options.dryRun) return { key: spec.key, action: 'would-update', id: existing.id, url: existing.html_url };
    await client.rest(`/gists/${existing.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ description: spec.description, files: toFilesPayload(spec.files) }),
    });
    return { key: spec.key, action: 'updated', id: existing.id, url: existing.html_url };
  }
  if (options.dryRun) return { key: spec.key, action: 'would-create', id: null, url: null };
  const created = await client.rest<RemoteGist>('/gists', {
    method: 'POST',
    body: JSON.stringify({ description: spec.description, public: options.public, files: toFilesPayload(spec.files) }),
  });
  return { key: spec.key, action: 'created', id: created.id, url: created.html_url };
}

/** Refuses before any write, so a declined run leaves nothing half-published. */
export function assertCreationAllowed(specs: GistSpec[], gists: RemoteGist[], options: PublishOptions): void {
  if (options.confirmed || options.dryRun) return;
  const missing = specs.filter((spec) => !findGist(gists, spec.primaryFile));
  if (missing.length) throw new ConfirmationRequired(missing);
}

export async function fetchRemoteLedger(client: GitHubClient, gists: RemoteGist[], filename: string): Promise<TokenLedger | null> {
  const gist = findGist(gists, filename);
  if (!gist) return null;
  try {
    const full = await client.rest<FullGist>(`/gists/${gist.id}`);
    const file = full.files[filename];
    if (!file) return null;
    const content = await fileContent(file);
    if (!content) return null;
    const ledger = JSON.parse(content) as TokenLedger;
    return ledger.version === 1 && ledger.days ? ledger : null;
  } catch (error) {
    if (error instanceof GitHubError || error instanceof SyntaxError) return null;
    throw error;
  }
}
