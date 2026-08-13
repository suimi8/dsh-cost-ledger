/**
 * Host-side HTTP API for the cost-ledger WebUI panel.
 *
 * Registered via ctx.inject(['webServer']) (web-profile-only). The browser
 * panel fetches JSON from these endpoints; polls on open for live updates.
 *
 * Routes (JSON):
 *   GET  /api/cost-ledger/summary?range=today|week|month|all
 *   GET  /api/cost-ledger/byProvider?range=...
 *   GET  /api/cost-ledger/logs?limit=100
 *   GET  /api/cost-ledger/budgets
 *   POST /api/cost-ledger/parse-prices  {text} → {prices}  (LLM-backed)
 *   POST /api/cost-ledger/cleanup        {filter} → {deleted, remaining}
 *   GET  /api/cost-ledger/cleanup/filters  → distinct model/provider/session/project
 */

import type { Ledger, UsageSummary, UsageRecord, BudgetRow, ProviderSummary, TrendPoint, CleanupFilter } from './store.ts'
import type { CostLedgerConfig } from './config.ts'
import { resolvePrice } from './pricing.ts'

export interface Totals {
  totalCost: number
  totalCalls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cacheHitRate: number
}

export interface SummaryResponse {
  range: string
  totals: Totals
  byModel: (UsageSummary & { unitPrice?: { input: number; output: number; cacheRead: number; cacheWrite: number } })[]
  budget?: { label: string; limit: number; window: string; spent: number; remaining: number; exceeded: boolean }
  pricedModels: string[]
}

export interface ByProviderResponse {
  range: string
  byProvider: ProviderSummary[]
}

export interface TrendResponse {
  range: string
  points: TrendPoint[]
}

export interface LogsResponse {
  rows: UsageRecord[]
}

export interface BudgetsResponse {
  budgets: BudgetRow[]
}

export interface ParsePricesResponse {
  prices: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>
}

// SDK-shape type mirror (see src/index.ts): the subset of StreamChunk we need
// to drain visible text from ctx.llm.stream(). Declared locally only because
// @deepseek-ai/dsh-llm is a host-injected (unpublished) package not resolvable
// at install time; swap for `import type { StreamChunk }` once the host publishes.
type TextDeltaChunk = { type: 'text-delta'; index: number; text: string }

/** Resolved default model selection (captured dynamically in src/index.ts). */
export interface ProviderModel {
  provider: string
  model: string
}

/**
 * Ask the host LLM to parse free-form price text into structured JSON.
 *
 * Uses ctx.llm.stream(options) — the real model-call waterfall (the same path
 * the agent loop uses), so the call is itself recorded by the cost-ledger's
 * llm/stream listener. Provider/model come from the host's default selection
 * (agentDefaultModel service); getProviderModel() yields null until that
 * service is up and a default model is configured.
 */
async function parsePricesWithLlm(
  ctx: any,
  text: string,
  getProviderModel: () => ProviderModel | null,
): Promise<ParsePricesResponse['prices']> {
  const sel = getProviderModel()
  if (!sel) {
    throw new Error('default model not configured; set a default model in Agent settings')
  }
  const llm = (ctx as any).llm
  if (typeof llm?.stream !== 'function') {
    throw new Error('llm service unavailable')
  }

  const prompt =
    '你是一个价格解析助手。下面是一段模型 API 的价格文本(单位:元/百万 token)。' +
    '请把它解析成 JSON 对象,键为模型名,值为 {"input":N,"output":N,"cacheRead":N,"cacheWrite":N},其中:\n' +
    '  - input: 输入 token 单价(非缓存)\n' +
    '  - output: 输出 token 单价\n' +
    '  - cacheRead: 缓存命中读取 token 单价(无则 0)\n' +
    '  - cacheWrite: 缓存写入 token 单价(无则 0)\n' +
    '只输出该 JSON 对象,不要任何解释、代码块标记或多余文字。数字只写纯数字。\n\n' +
    '价格文本:\n' + text

  const stream = llm.stream({
    provider: sel.provider,
    model: sel.model,
    messages: [{ role: 'user', content: prompt }],
  }) as AsyncIterable<TextDeltaChunk | { type: string }>

  let buf = ''
  for await (const chunk of stream) {
    if (chunk && (chunk as TextDeltaChunk).type === 'text-delta') {
      buf += (chunk as TextDeltaChunk).text
    }
  }

  return extractPrices(buf)
}

/**
 * Pull the first balanced {...} substring out of the model output (LLMs
 * occasionally wrap JSON in prose or ```fences), parse it, and validate the
 * shape: a flat object mapping model name → {input,output,cacheRead,cacheWrite}
 * numbers. Missing numeric fields coerce to 0; non-object values are dropped.
 */
function extractPrices(raw: string): ParsePricesResponse['prices'] {
  const start = raw.indexOf('{')
  if (start === -1) throw new Error('LLM 返回的内容中没有 JSON 对象')
  // Find the matching closing brace for the first '{' (handles nested braces).
  let depth = 0
  let end = -1
  for (let i = start; i < raw.length; i++) {
    const c = raw[i]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) { end = i; break }
    }
  }
  if (end === -1) throw new Error('LLM 返回的 JSON 不完整')
  let obj: unknown
  try {
    obj = JSON.parse(raw.slice(start, end + 1))
  } catch (err) {
    throw new Error('LLM 返回的内容无法解析为 JSON: ' + String(err))
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('LLM 返回的不是对象')
  }
  const out: ParsePricesResponse['prices'] = {}
  for (const [model, val] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof model !== 'string') continue
    const key = model.trim()
    // Validate the model-name key: non-empty, bounded length, no control chars.
    // Unconstrained keys would pollute resolvePrice's prefix matching.
    if (!key || key.length > 128 || /[\x00-\x1f\x7f]/.test(key)) continue
    if (!val || typeof val !== 'object' || Array.isArray(val)) continue
    const v = val as Record<string, unknown>
    out[key] = {
      input: num(v.input),
      output: num(v.output),
      cacheRead: num(v.cacheRead),
      cacheWrite: num(v.cacheWrite),
    }
  }
  if (Object.keys(out).length === 0) throw new Error('未能从价格文本中识别出任何模型')
  return out
}

function num(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) && n >= 0 ? n : 0
}

function resolveSince(range: string): string | undefined {
  if (!range || range === 'all') return undefined
  if (range === 'today' || range === 'daily') {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return d.toISOString()
  }
  if (range === 'week' || range === 'weekly') {
    const d = new Date()
    d.setDate(d.getDate() - 7)
    return d.toISOString()
  }
  if (range === 'month' || range === 'monthly') {
    const d = new Date()
    d.setMonth(d.getMonth() - 1)
    return d.toISOString()
  }
  return range
}

/**
 * Guard for write/POST endpoints. Rejects cross-origin browsers requests that a
 * malicious page can still fire (simple <form> POSTs and `fetch(...,{mode:'no-cors'})`).
 *
 * `webServer` serves the Web UI from the same origin as this API. Legitimate
 * same-origin fetches carry a JSON `Content-Type`, which a cross-origin simple
 * request cannot set. A cross-origin simple POST (the kind a hostile page
 * fires) arrives with a non-JSON Content-Type (or none), so we 403 it.
 *
 * This is a same-origin CSRF guard, not authentication: it raises the bar so a
 * random webpage cannot wipe the ledger or flip pricing without already being
 * able to run arbitrary JS against the DSH origin.
 */
function isAuthorizedWrite(req: any): boolean {
  const ct = String(req?.headers?.['content-type'] ?? '').split(';')[0].trim().toLowerCase()
  if (ct !== 'application/json') return false
  // Origin/Referer, when present, must match the host (same-origin). Absent
  // Origin (non-browser callers like curl) is allowed — it is not a CSRF vector.
  const origin = req?.headers?.origin
  const referer = req?.headers?.referer
  const host = req?.headers?.host
  if (host) {
    if (origin && !sameHost(origin, host)) return false
    if (referer && !sameHost(referer, host)) return false
  }
  return true
}

function sameHost(url: string, host: string): boolean {
  try {
    const u = new URL(url)
    return u.host === host
  } catch {
    return false
  }
}

function sendJson(res: any, status: number, body: unknown): void {
  const json = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', Buffer.byteLength(json))
  res.end(json)
}

function readQuery(url: string): Record<string, string> {
  const q = url.split('?')[1]
  if (!q) return {}
  const out: Record<string, string> = {}
  for (const pair of q.split('&')) {
    const [k, v] = pair.split('=')
    if (k) out[decodeURIComponent(k)] = decodeURIComponent(v ?? '')
  }
  return out
}

export function registerHttpApi(
  ctx: any,
  ledger: Ledger,
  getConfig: () => CostLedgerConfig,
  setConfig?: (patch: Partial<CostLedgerConfig>) => Promise<void>,
  getProviderModel?: () => ProviderModel | null,
): void {
  let webServer: any
  try {
    webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
  } catch {
    webServer = undefined
  }
  if (typeof webServer?.register !== 'function') return

  const readBody = (req: any): Promise<string> => new Promise((resolve) => {
    let data = ''
    req.on('data', (c: Buffer) => { data += c.toString() })
    req.on('end', () => resolve(data))
  })

  const handler = async (req: any, res: any): Promise<void> => {
    const url: string = req.url ?? ''
    const path = url.split('?')[0]
    const query = readQuery(url)

    try {
      const config = getConfig()
      // Resolve price for a model from current config + built-in defaults.
      const priceResolver = (model: string) => resolvePrice(model, config.pricing)

      if (path === '/api/cost-ledger/summary') {
        const range = query.range ?? 'all'
        const since = resolveSince(range)
        const byModel = ledger.summaryByModel(since, undefined, priceResolver)
        const inputTokens = byModel.reduce((s, m) => s + m.inputTokens, 0)
        const outputTokens = byModel.reduce((s, m) => s + m.outputTokens, 0)
        const cacheReadTokens = byModel.reduce((s, m) => s + m.cacheReadTokens, 0)
        const cacheWriteTokens = byModel.reduce((s, m) => s + m.cacheWriteTokens, 0)
        const totalCost = byModel.reduce((s, m) => s + m.cost, 0)
        const totalCalls = byModel.reduce((s, m) => s + m.calls, 0)
        // cache hit rate = cacheRead / (input + cacheRead + cacheWrite)
        const denom = inputTokens + cacheReadTokens + cacheWriteTokens
        const cacheHitRate = denom > 0 ? cacheReadTokens / denom : 0
        const pricedModels = Object.keys(config.pricing)
        const byModelPriced = byModel.map((m) => {
          const price = resolvePrice(m.model, config.pricing)
          return price ? { ...m, unitPrice: price } : m
        })
        let budget: SummaryResponse['budget']
        const limit = config.defaultDailyBudget
        if (limit > 0) {
          const spent = ledger.spentSince(resolveSince('today')!, undefined, priceResolver)
          budget = {
            label: 'daily',
            limit,
            window: 'daily',
            spent,
            remaining: Math.max(0, limit - spent),
            exceeded: spent >= limit,
          }
        }
        const body: SummaryResponse = {
          range,
          totals: { totalCost, totalCalls, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cacheHitRate },
          byModel: byModelPriced,
          budget,
          pricedModels,
        }
        return sendJson(res, 200, body)
      }

      if (path === '/api/cost-ledger/byProvider') {
        const range = query.range ?? 'all'
        const since = resolveSince(range)
        return sendJson(res, 200, { range, byProvider: ledger.summaryByProvider(since, undefined, priceResolver) } as ByProviderResponse)
      }

      if (path === '/api/cost-ledger/logs') {
        const limit = Math.min(500, Math.max(1, Number(query.limit ?? '100') || 100))
        return sendJson(res, 200, { rows: ledger.recent(limit) } as LogsResponse)
      }

      if (path === '/api/cost-ledger/trend') {
        const range = query.range ?? 'all'
        const since = resolveSince(range)
        return sendJson(res, 200, { range, points: ledger.trend(since) } as TrendResponse)
      }

      if (path === '/api/cost-ledger/budgets') {
        return sendJson(res, 200, { budgets: ledger.listBudgets() } as BudgetsResponse)
      }

      if (path === '/api/cost-ledger/cleanup') {
        if (req.method !== 'POST') return sendJson(res, 200, { count: ledger.count() })
        if (!isAuthorizedWrite(req)) return sendJson(res, 403, { error: 'forbidden: cross-origin write blocked' })
        const body = await readBody(req)
        let parsed: any
        try {
          parsed = JSON.parse(body || '{}')
        } catch {
          return sendJson(res, 400, { error: 'invalid JSON' })
        }
        let deleted: number
        // Backward compat: a bare { days } still means "older than N days".
        // Any other filter field (model/provider/sessionId/project/beforeTs/
        // sinceTs) selects the general cleanup() path with selective criteria.
        const hasFilter =
          parsed.model !== undefined || parsed.provider !== undefined ||
          parsed.sessionId !== undefined || parsed.project !== undefined ||
          parsed.beforeTs !== undefined || parsed.sinceTs !== undefined ||
          parsed.all === true
        if (hasFilter) {
          const filter: CleanupFilter = {}
          if (parsed.olderThanDays !== undefined) filter.olderThanDays = Number(parsed.olderThanDays)
          if (parsed.beforeTs !== undefined) filter.beforeTs = String(parsed.beforeTs)
          if (parsed.sinceTs !== undefined) filter.sinceTs = String(parsed.sinceTs)
          if (parsed.model !== undefined) filter.model = String(parsed.model)
          if (parsed.provider !== undefined) filter.provider = parsed.provider === null ? null : String(parsed.provider)
          if (parsed.sessionId !== undefined) filter.sessionId = parsed.sessionId === null ? null : String(parsed.sessionId)
          if (parsed.project !== undefined) filter.project = parsed.project === null ? null : String(parsed.project)
          deleted = ledger.cleanup(filter)
        } else {
          // Legacy {days} path — olderThanDays; defaults to 0 (delete nothing)
          // rather than 30, so an accidental click with an empty field doesn't
          // wipe a month of data. Explicit "all" is required to clear everything.
          const days = Number(parsed.days ?? 0)
          deleted = ledger.cleanupOlderThan(Math.max(0, days))
        }
        return sendJson(res, 200, { deleted, remaining: ledger.count() })
      }

      if (path === '/api/cost-ledger/cleanup/filters') {
        return sendJson(res, 200, ledger.cleanupFilterOptions())
      }

      if (path === '/api/cost-ledger/config') {
        if (req.method === 'GET') {
          return sendJson(res, 200, getConfig())
        }
        if (req.method === 'POST') {
          if (!setConfig) return sendJson(res, 501, { error: 'config write unavailable' })
          if (!isAuthorizedWrite(req)) return sendJson(res, 403, { error: 'forbidden: cross-origin write blocked' })
          const body = await readBody(req)
          let patch: Partial<CostLedgerConfig>
          try {
            patch = JSON.parse(body)
          } catch {
            return sendJson(res, 400, { error: 'invalid JSON' })
          }
          try {
            await setConfig(patch)
            return sendJson(res, 200, getConfig())
          } catch (err) {
            return sendJson(res, 500, { error: String(err) })
          }
        }
      }

      if (path === '/api/cost-ledger/parse-prices') {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        if (!getProviderModel) return sendJson(res, 501, { error: 'parse-prices unavailable' })
        if (!isAuthorizedWrite(req)) return sendJson(res, 403, { error: 'forbidden: cross-origin write blocked' })
        const body = await readBody(req)
        let text: string
        try {
          text = String(JSON.parse(body || '{}').text ?? '')
        } catch {
          return sendJson(res, 400, { error: 'invalid JSON' })
        }
        if (!text.trim()) return sendJson(res, 400, { error: 'empty text' })
        try {
          const prices = await parsePricesWithLlm(ctx, text, getProviderModel)
          return sendJson(res, 200, { prices } as ParsePricesResponse)
        } catch (err) {
          return sendJson(res, 500, { error: String(err) })
        }
      }

      return sendJson(res, 404, { error: 'not found' })
    } catch (err) {
      return sendJson(res, 500, { error: String(err) })
    }
  }

  const dispose = webServer.register({ kind: 'prefix', path: '/api/cost-ledger', handler })
  if (typeof dispose === 'function') {
    ctx.effect?.(() => dispose)
  }
  ctx.logger?.info?.('[cost-ledger] HTTP API at /api/cost-ledger')
}
