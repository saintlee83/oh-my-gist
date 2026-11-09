import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createZstdDecompress } from 'node:zlib';

export type Tool = 'claude' | 'codex';

/**
 * One billable model response, normalized across tools:
 * `input` excludes cached tokens and `output` includes reasoning tokens.
 * Parsers read usage fields only. Prompts, responses and paths are never kept.
 */
export interface UsageEvent {
  key: string;
  at: string;
  tool: Tool;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

async function* readLines(path: string): AsyncGenerator<string> {
  const file = createReadStream(path);
  const source = path.endsWith('.zst') ? file.pipe(createZstdDecompress()) : file;
  let failure: Error | null = null;
  const lines = createInterface({ input: source, crlfDelay: Infinity });
  const fail = (error: Error) => {
    failure = error;
    lines.close();
  };
  file.on('error', fail);
  source.on('error', fail);
  yield* lines;
  if (failure) throw failure;
}

function parse(line: string): any {
  try {
    return JSON.parse(line);
  } catch {
    // Logs can end mid-line while a session is still writing.
    return null;
  }
}

const count = (value: unknown): number => (typeof value === 'number' && value > 0 ? value : 0);

/**
 * Claude Code writes one row per content block and copies rows into resumed
 * sessions, so around half of all rows repeat. `message.id:requestId` identifies
 * the response; see `mergeEvents` for how repeats are resolved.
 */
export async function parseClaudeLog(path: string): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  for await (const line of readLines(path)) {
    if (!line.includes('"usage"')) continue;
    const row = parse(line);
    if (row?.type !== 'assistant') continue;
    const message = row.message;
    const usage = message?.usage;
    const model = message?.model;
    if (!usage || !model || model === '<synthetic>' || !message.id) continue;
    events.push({
      key: `${message.id}:${row.requestId ?? ''}`,
      at: row.timestamp,
      tool: 'claude',
      model,
      input: count(usage.input_tokens),
      output: count(usage.output_tokens),
      cacheRead: count(usage.cache_read_input_tokens),
      cacheWrite: count(usage.cache_creation_input_tokens),
    });
  }
  return events;
}

function normalizeCodexUsage(usage: any): Pick<UsageEvent, 'input' | 'output' | 'cacheRead' | 'cacheWrite'> {
  const cacheRead = count(usage.cached_input_tokens);
  const cacheWrite = count(usage.cache_write_input_tokens);
  return {
    // Unlike Claude, OpenAI's input_tokens already includes cached tokens.
    input: Math.max(0, count(usage.input_tokens) - cacheRead - cacheWrite),
    output: count(usage.output_tokens),
    cacheRead,
    cacheWrite,
  };
}

/**
 * Newer Codex logs have a `token_usage_record` per response with a unique id.
 * Older ones only have `token_count` events, which repeat when nothing changed,
 * so those are deduped on the session's running total.
 */
export async function parseCodexLog(path: string): Promise<UsageEvent[]> {
  const records: UsageEvent[] = [];
  const legacy: UsageEvent[] = [];
  let model = 'unknown';
  let firstModel: string | null = null;
  let lastTotal = -1;

  for await (const line of readLines(path)) {
    if (!line.includes('token_usage_record') && !line.includes('"token_count"') && !line.includes('"turn_context"')) continue;
    const row = parse(line);
    const payload = row?.payload;
    if (!payload || typeof payload !== 'object') continue;

    if (row.type === 'turn_context') {
      if (typeof payload.model === 'string' && payload.model) {
        model = payload.model;
        firstModel ??= model;
      }
    } else if (row.type === 'token_usage_record' && payload.usage && payload.response_id) {
      records.push({
        key: `codex:${payload.response_id}`,
        at: row.timestamp,
        tool: 'codex',
        model,
        ...normalizeCodexUsage(payload.usage),
      });
    } else if (payload.type === 'token_count' && payload.info?.last_token_usage) {
      const total = count(payload.info.total_token_usage?.total_tokens);
      if (total === lastTotal) continue;
      lastTotal = total;
      legacy.push({
        key: `codex:${path}:${total}`,
        at: row.timestamp,
        tool: 'codex',
        model,
        ...normalizeCodexUsage(payload.info.last_token_usage),
      });
    }
  }
  // Newer logs carry both forms for the same responses, so never add them together.
  const events = records.length ? records : legacy;
  // Some sessions report usage before their first turn_context line.
  for (const event of events) {
    if (event.model === 'unknown' && firstModel) event.model = firstModel;
  }
  return events;
}

/**
 * Resolves repeats across every log. Rows for one response can differ while it
 * streams, so the row with the most output is the finished one.
 */
export function mergeEvents(events: Iterable<UsageEvent>): UsageEvent[] {
  const byKey = new Map<string, UsageEvent>();
  for (const event of events) {
    const existing = byKey.get(event.key);
    if (!existing || event.output > existing.output) byKey.set(event.key, event);
  }
  return [...byKey.values()];
}
