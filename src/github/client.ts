import { execFileSync } from 'node:child_process';

export class RateLimitExhausted extends Error {
  resetAt: Date | null;
  constructor(resource: string, resetAt: Date | null) {
    super(`GitHub ${resource} rate limit exhausted${resetAt ? ` until ${resetAt.toISOString()}` : ''}`);
    this.name = 'RateLimitExhausted';
    this.resetAt = resetAt;
  }
}

export class GitHubError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(`GitHub ${status}: ${message}`);
    this.name = 'GitHubError';
    this.status = status;
  }
}

/** GraphQL can answer with partial data and per-field errors, such as one forbidden repo. */
export class GraphQLError extends Error {
  partial: unknown;
  constructor(message: string, partial: unknown) {
    super(`GitHub GraphQL: ${message}`);
    this.name = 'GraphQLError';
    this.partial = partial;
  }
}

export class MissingScopes extends Error {
  missing: string[];
  constructor(missing: string[]) {
    super(
      `This token is missing the ${missing.join(', ')} scope${missing.length > 1 ? 's' : ''}. ` +
        'Without them, private work would silently drop out of your public cards, so nothing was changed. ' +
        'Fix it with `gh auth refresh -s repo,read:org,gist`, or create a classic token with those scopes.',
    );
    this.name = 'MissingScopes';
    this.missing = missing;
  }
}

/** Broader scopes that also grant the one being checked. */
const IMPLIED_BY: Record<string, string[]> = { 'read:org': ['write:org', 'admin:org'] };

/** Actions logs are public on a public repo, and API errors can quote private names. */
export function redactQuoted(message: string): string {
  return message.replace(/'[^']*'|"[^"]*"/g, "'[redacted]'");
}

/**
 * The first two are explicit opt-ins. GITHUB_TOKEN comes last because the
 * workflow token Actions provides cannot write gists or read private org repos.
 */
export function resolveToken(env: NodeJS.ProcessEnv = process.env): { token: string; source: string } {
  for (const name of ['OH_MY_GIST_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']) {
    const value = env[name];
    if (value) return { token: value, source: name };
  }
  try {
    const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (token) return { token, source: 'gh auth token' };
  } catch {
    // Fall through to the error below.
  }
  throw new Error('No GitHub token. Run `gh auth login` or set OH_MY_GIST_TOKEN (scopes: repo, read:org, gist).');
}

export interface ClientOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  /** Replaceable so tests do not actually wait out backoff. */
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

export class GitHubClient {
  coreRemaining: number | null = null;
  scopes: string | null = null;
  private token: string;
  private fetchImpl: typeof fetch;
  private baseUrl: string;
  private sleep: (ms: number) => Promise<void>;
  private maxAttempts: number;

  constructor(token: string, options: ClientOptions = {}) {
    this.token = token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? 'https://api.github.com';
    this.sleep = options.sleep ?? defaultSleep;
    this.maxAttempts = options.maxAttempts ?? 5;
  }

  /**
   * Classic and OAuth tokens report their scopes on every response. Fine-grained
   * tokens report none, so they can't be checked here and count as having everything.
   */
  missingScopes(required: string[]): string[] {
    if (this.scopes === null || /^(github_pat_|ghs_)/.test(this.token)) return [];
    const granted = new Set(this.scopes.split(',').map((scope) => scope.trim()));
    return required.filter(
      (scope) => !granted.has(scope) && !(IMPLIED_BY[scope] ?? []).some((broader) => granted.has(broader)),
    );
  }

  assertScopes(required: string[]): void {
    const missing = this.missingScopes(required);
    if (missing.length) throw new MissingScopes(missing);
  }

  private async send(path: string, init: RequestInit, resource: string): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      if (attempt > 1) await this.sleep(Math.min(30_000, 1000 * 2 ** (attempt - 2)));
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          ...init,
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'oh-my-gist',
            ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          },
        });
      } catch (error) {
        lastError = error;
        continue;
      }

      const scopes = response.headers.get('x-oauth-scopes');
      if (scopes !== null) this.scopes = scopes;
      const remaining = response.headers.get('x-ratelimit-remaining');
      if (resource === 'rest' && remaining !== null) this.coreRemaining = Number(remaining);

      if (response.status === 403 || response.status === 429) {
        const retryAfter = Number(response.headers.get('retry-after'));
        if (retryAfter > 0) {
          // Secondary limit: GitHub says exactly how long to back off.
          lastError = new GitHubError(response.status, 'secondary rate limit');
          await this.sleep(Math.min(retryAfter, 120) * 1000);
          continue;
        }
        if (remaining === '0') {
          const reset = Number(response.headers.get('x-ratelimit-reset'));
          throw new RateLimitExhausted(resource, reset ? new Date(reset * 1000) : null);
        }
      }
      if (response.status >= 500) {
        lastError = new GitHubError(response.status, 'server error');
        continue;
      }
      return response;
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async rest<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.send(path, init, 'rest');
    const text = await response.text();
    if (!response.ok) {
      let message = text.slice(0, 200);
      try {
        message = JSON.parse(text).message ?? message;
      } catch {
        // Keep the raw text.
      }
      throw new GitHubError(response.status, message);
    }
    return (text ? JSON.parse(text) : null) as T;
  }

  async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const response = await this.send(
      '/graphql',
      { method: 'POST', body: JSON.stringify({ query, variables }) },
      'graphql',
    );
    const text = await response.text();
    if (!response.ok) throw new GitHubError(response.status, text.slice(0, 200));
    const body = JSON.parse(text) as { data?: T; errors?: { message: string; type?: string }[] };
    if (body.errors?.length) {
      if (body.errors.some((error) => error.type === 'RATE_LIMITED')) {
        throw new RateLimitExhausted('graphql', null);
      }
      throw new GraphQLError(body.errors.map((error) => error.message).join('; '), body.data ?? null);
    }
    return body.data as T;
  }
}

/** Runs `worker` over items with bounded concurrency. Stops early if `shouldStop` turns true. */
export async function pool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
  shouldStop: () => boolean = () => false,
): Promise<void> {
  let next = 0;
  const run = async () => {
    while (next < items.length && !shouldStop()) {
      const index = next++;
      await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, run));
}
