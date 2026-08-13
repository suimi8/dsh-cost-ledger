/**
 * Built-in DeepSeek model pricing, in CNY per 1,000,000 tokens.
 *
 * Source: DeepSeek official pricing page (https://api-docs.deepseek.com/zh-cn/quick_start/pricing).
 * Snapshot date: 2026-08-14. Prices may change — users can override any entry via
 * the `pricing` config field, and add arbitrary models there too.
 *
 * Pricing model (DeepSeek V4 official):
 *  - `input`      = non-cached input tokens (cache MISS). This is the price of
 *                   tokens that were NOT served from the prompt cache.
 *  - `cacheRead`  = tokens served FROM the prompt cache (cache HIT). This is
 *                   much CHEAPER than `input` (typically 30–50× cheaper).
 *  - `cacheWrite` = tokens written INTO the prompt cache. DeepSeek V4 bills
 *                   cache writes at the same rate as a cache-miss input, so we
 *                   set `cacheWrite = input`. (DSH's TokenUsage exposes
 *                   cacheWriteTokens separately from inputTokens; billing both
 *                   at the miss rate avoids under-counting.)
 *  - `output`     = generated output tokens.
 *
 * All prices are CNY per million tokens. `0` means "unknown / not tracked as money".
 */

export interface ModelPrice {
  /** CNY per 1M input tokens (non-cached / cache-miss). */
  input: number
  /** CNY per 1M output tokens. */
  output: number
  /** CNY per 1M input tokens served from the prompt cache (cache-hit read). */
  cacheRead: number
  /** CNY per 1M input tokens written into the prompt cache. */
  cacheWrite: number
}

export const PRICING_CURRENCY = 'CNY'

/**
 * Built-in model pricing (CNY per 1M tokens). Cache-read is always cheaper than
 * input; cache-write equals the input (cache-miss) rate under DeepSeek V4.
 *
 * For V4 models, DeepSeek publishes only cache-hit / cache-miss / output — no
 * separate cache-write line — so cacheWrite mirrors input (the miss rate).
 */
export const DEFAULT_PRICING: Record<string, ModelPrice> = {
  // DeepSeek V4 (official pricing page, CNY/1M tokens, snapshot 2026-08-14).
  // v4-flash: input(cache miss) 1 / input(cache hit) 0.02 / output 2.
  'deepseek-v4-flash': {
    input: 1,
    output: 2,
    cacheRead: 0.02,
    cacheWrite: 1,
  },
  // v4-pro: input(cache miss) 3 / input(cache hit) 0.025 / output 6.
  'deepseek-v4-pro': {
    input: 3,
    output: 6,
    cacheRead: 0.025,
    cacheWrite: 3,
  },
  // DeepSeek V3 / R1 (legacy CNY pricing still routed by some deployments).
  // cacheWrite mirrors input (cache-miss rate) per DeepSeek's billing model.
  'deepseek-chat': {
    input: 2,
    output: 8,
    cacheRead: 0.5,
    cacheWrite: 2,
  },
  'deepseek-reasoner': {
    input: 4,
    output: 16,
    cacheRead: 1,
    cacheWrite: 4,
  },
  // GLM-5-2 (Zhipu) — not in the public free catalog; default 0, override in config.
  'glm-5-2': {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
}

/**
 * Keys in priority order for prefix matching. Longest key first so that a more
 * specific override (e.g. "deepseek-chat") wins over a shorter prefix
 * (e.g. "deepseek"). Insertion-order iteration previously let a short override
 * key silently shadow a more specific one.
 */
function orderedKeys(record: Record<string, unknown> | undefined): string[] {
  const keys = record ? Object.keys(record) : []
  keys.sort((a, b) => b.length - a.length)
  return keys
}

/**
 * Resolve the price for a model name, preferring a user override and falling
 * back to the built-in table. Returns null when no price is known — callers
 * should then record token counts only, with cost = 0.
 *
 * Matching precedence (longest-prefix wins, both within overrides and the
 * built-in table): an override key is checked before any built-in key so user
 * configuration always wins.
 */
export function resolvePrice(
  model: string,
  overrides?: Record<string, ModelPrice>,
): ModelPrice | null {
  if (!model) return null

  // Exact overrides first, then prefix overrides (longest key wins).
  if (overrides && overrides[model]) return overrides[model]
  for (const key of orderedKeys(overrides)) {
    if (model.startsWith(key)) return overrides![key]
  }

  // Built-in table: exact, then prefix (longest key wins).
  if (DEFAULT_PRICING[model]) return DEFAULT_PRICING[model]
  for (const key of orderedKeys(DEFAULT_PRICING)) {
    if (model.startsWith(key)) return DEFAULT_PRICING[key]
  }
  return null
}

/**
 * Compute the cost (CNY) of a single usage record.
 * Tokens are raw counts; prices are per-million.
 */
export function computeCost(
  price: ModelPrice,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
): number {
  const per = 1_000_000
  return (
    (inputTokens * price.input) / per +
    (outputTokens * price.output) / per +
    (cacheReadTokens * price.cacheRead) / per +
    (cacheWriteTokens * price.cacheWrite) / per
  )
}
