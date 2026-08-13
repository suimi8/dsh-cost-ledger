/**
 * Built-in DeepSeek model pricing, in CNY per 1,000,000 tokens.
 *
 * Source: DeepSeek official pricing page (https://api-docs.deepseek.com/quick_start/pricing).
 * Snapshot date: 2025-01. Prices may change — users can override any entry via
 * the `pricing` config field, and add arbitrary models there too.
 *
 * `cacheRead` is the discounted price for tokens served from the prompt cache.
 * `cacheWrite` is the (higher) price for tokens written into the cache.
 *
 * All prices are CNY per million tokens. `0` means "unknown / not tracked as money".
 */

export interface ModelPrice {
  /** CNY per 1M input tokens (non-cached). */
  input: number
  /** CNY per 1M output tokens. */
  output: number
  /** CNY per 1M input tokens served from the prompt cache (cache hit read). */
  cacheRead: number
  /** CNY per 1M input tokens written into the prompt cache. */
  cacheWrite: number
}

export const DEFAULT_PRICING: Record<string, ModelPrice> = {
  // DeepSeek V4 (current official pricing, api-docs.deepseek.com, peak tier).
  // Flash: input 0.10 / output 3.0 / cache-read 9.0 (元/百万 tokens).
  'deepseek-v4-flash': {
    input: 0.1,
    output: 3,
    cacheRead: 9,
    cacheWrite: 3,
  },
  // Pro: input 0.30 / output 9.0 / cache-read 27.0.
  'deepseek-v4-pro': {
    input: 0.3,
    output: 9,
    cacheRead: 27,
    cacheWrite: 9,
  },
  // DeepSeek V3 / R1 (legacy aliases still routed by some deployments).
  'deepseek-chat': {
    input: 2,
    output: 8,
    cacheRead: 0.5,
    cacheWrite: 8,
  },
  'deepseek-reasoner': {
    input: 4,
    output: 16,
    cacheRead: 1,
    cacheWrite: 8,
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
 * Resolve the price for a model name, preferring a user override and falling
 * back to the built-in table. Returns null when no price is known — callers
 * should then record token counts only, with cost = 0.
 */
export function resolvePrice(
  model: string,
  overrides?: Record<string, ModelPrice>,
): ModelPrice | null {
  if (overrides && overrides[model]) return overrides[model]
  if (DEFAULT_PRICING[model]) return DEFAULT_PRICING[model]
  // Loose match: a config override keyed on a prefix (e.g. "deepseek-chat") should
  // also cover variant names like "deepseek-chat-20250120".
  if (overrides) {
    for (const key of Object.keys(overrides)) {
      if (model.startsWith(key)) return overrides[key]
    }
  }
  for (const key of Object.keys(DEFAULT_PRICING)) {
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
