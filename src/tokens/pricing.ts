import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Price, PriceTable } from '../types.ts';

/** Community-maintained list prices, so new models need no release of this tool. */
const PRICES_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const MAX_AGE_MS = 24 * 3_600_000;

interface RawPrice {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number | null;
  cache_creation_input_token_cost?: number | null;
}

export function trimPrices(raw: Record<string, RawPrice>): PriceTable {
  const table: PriceTable = {};
  for (const [model, entry] of Object.entries(raw)) {
    if (typeof entry?.input_cost_per_token !== 'number' || typeof entry.output_cost_per_token !== 'number') continue;
    table[model] = {
      input: entry.input_cost_per_token,
      output: entry.output_cost_per_token,
      cacheRead: entry.cache_read_input_token_cost ?? null,
      cacheWrite: entry.cache_creation_input_token_cost ?? null,
    };
  }
  return table;
}

/** Falls back to a stale copy, then to an empty table: costs go unknown rather than wrong. */
export async function loadPrices(home: string, fetchImpl: typeof fetch = fetch): Promise<PriceTable> {
  const path = join(home, 'prices.json');
  const cached = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as PriceTable) : null;
  if (cached && Date.now() - statSync(path).mtimeMs < MAX_AGE_MS) return cached;
  try {
    const response = await fetchImpl(PRICES_URL, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) return cached ?? {};
    const table = trimPrices((await response.json()) as Record<string, RawPrice>);
    writeFileSync(path, JSON.stringify(table));
    return table;
  } catch {
    return cached ?? {};
  }
}

export function findPrice(prices: PriceTable, model: string): Price | null {
  const undated = model.replace(/-\d{8}$/, '');
  for (const name of [model, undated, `anthropic/${undated}`, `openai/${undated}`]) {
    if (prices[name]) return prices[name];
  }
  return null;
}

/** Cost at public API list price. Subscription plans pay differently, so this is a yardstick. */
export function costOf(
  price: Price,
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number },
): number {
  return (
    usage.input * price.input +
    usage.output * price.output +
    usage.cacheRead * (price.cacheRead ?? price.input) +
    usage.cacheWrite * (price.cacheWrite ?? price.input)
  );
}
