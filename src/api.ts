/**
 * Host-side HTTP API for the cost-ledger WebUI panel.
 *
 * Registered via ctx.inject(['webServer']) (web-profile-only). The browser
 * panel fetches JSON from these endpoints; polls on open for live updates.
 *
 * Routes (all GET, JSON):
 *   /api/cost-ledger/summary?range=today|week|month|all
 *   /api/cost-ledger/byProvider?range=...
 *   /api/cost-ledger/logs?limit=100
 *   /api/cost-ledger/budgets
 */

import type { Ledger, UsageSummary, UsageRecord, BudgetRow, ProviderSummary, TrendPoint } from './store.ts'
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
          const spent = ledger.spentSince(resolveSince('today')!)
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
        const body = await readBody(req)
        const days = Number(JSON.parse(body || '{}').days ?? 30)
        const deleted = ledger.cleanupOlderThan(Math.max(1, days))
        return sendJson(res, 200, { deleted, remaining: ledger.count() })
      }

      if (path === '/api/cost-ledger/config') {
        if (req.method === 'GET') {
          return sendJson(res, 200, getConfig())
        }
        if (req.method === 'POST') {
          if (!setConfig) return sendJson(res, 501, { error: 'config write unavailable' })
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
