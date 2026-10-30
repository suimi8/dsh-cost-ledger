/**
 * Tool definitions for dsh-cost-ledger, shaped to the real DSH ToolDefinition
 * contract (from @deepseek-ai/dsh-tools):
 *
 *   interface ToolDefinition extends ToolSchema {
 *     readonly output: ToolOutputDefinition   // schema + render
 *     execute(args, exec: ToolRunContext): Promise<unknown>   // canonical JSON value
 *   }
 *   interface ToolSchema { name; description; parameters: JsonSchemaNode }
 *
 * The canonical value returned by `execute` is validated against
 * `output.schema` and then projected to model-facing ContentBlock[] by
 * `output.render`. We use a permissive `type:'object'` output schema and a
 * text render (JSON.stringify) so the tool results are visible to the agent
 * without depending on richer content-block helpers.
 *
 * These type declarations mirror the host SDK shapes field-for-field so the
 * plugin runs against the real ToolRuntime.register() unchanged. They are
 * declared locally only because @deepseek-ai/dsh-tools/dsh-llm/dsh-session are
 * host-injected (unpublished) packages not resolvable at install time.
 */

import type { Ledger, UsageSummary, BudgetRow } from './store.ts'
import type { CostLedgerConfig } from './config.ts'
import { resolvePrice, computeCost } from './pricing.ts'

// ---------------------------------------------------------------------------
// SDK-shape type mirrors (see @deepseek-ai/dsh-llm / dsh-tools / dsh-session)
// ---------------------------------------------------------------------------

/** Enforced JSON Schema subset accepted by the host. */
export interface JsonSchemaNode {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'
  oneOf?: JsonSchemaNode[]
  properties?: Record<string, JsonSchemaNode>
  required?: string[]
  additionalProperties?: boolean
  items?: JsonSchemaNode
  enum?: (string | number | boolean | null)[]
  const?: string | number | boolean | null
  description?: string
  title?: string
  default?: unknown
  examples?: unknown
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

export interface TextBlock {
  type: 'text'
  text: string
}
export type ContentBlock = TextBlock | { type: string; [k: string]: unknown }

export interface ToolOutputDefinition {
  readonly schema: JsonSchemaNode
  render(args: unknown, value: JsonValue): ContentBlock[]
  presentationMeta?(args: unknown, value: JsonValue): JsonValue
}

export interface ToolSchema {
  name: string
  description: string
  parameters: JsonSchemaNode
}

/** Minimal ToolRunContext: we only need cancellation + arguments. */
export interface ToolRunContext {
  readonly arguments: unknown
  readonly signal: AbortSignal
  deferContext?(context: unknown): void
}

export interface ToolDefinition extends ToolSchema {
  readonly output: ToolOutputDefinition
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>
  timeoutMs?: number
  isConcurrencySafe?(args: unknown): boolean
}

// ---------------------------------------------------------------------------

export interface ToolContext {
  ledger: Ledger
  config: CostLedgerConfig
  sessionId: string | null
  project: string | null
}

/** ISO timestamp for the start of a named window, or undefined for "all". */
function resolveSince(range: string): string | undefined {
  if (!range || range === 'all' || range === 'never') return undefined
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

/** Shared permissive output schema: any JSON object. */
const objectOutputSchema: JsonSchemaNode = {
  type: 'object',
  additionalProperties: true,
}

/** Shared text render: project the canonical JSON value to a text block. */
function textRender(_args: unknown, value: JsonValue): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

function makeOutput(): ToolOutputDefinition {
  return { schema: objectOutputSchema, render: textRender }
}

// --- record_cost -----------------------------------------------------------

export interface RecordCostArgs {
  model: string
  provider?: string
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  ts?: string
}

export interface RecordCostValue {
  id: number
  cost: number
}

export const recordCostTool: ToolDefinition = {
  name: 'record_cost',
  description:
    'Record one LLM token-usage entry into the persistent cost ledger. ' +
    'Normally called automatically by the token listener; use this to backfill or log out-of-band usage.',
  parameters: {
    type: 'object',
    required: ['model'],
    additionalProperties: false,
    properties: {
      model: { type: 'string', description: 'Model name, e.g. "deepseek-chat".' },
      provider: { type: 'string', description: 'Provider route, e.g. "deepseek-official".' },
      inputTokens: { type: 'integer', default: 0, description: 'Uncached input tokens.' },
      outputTokens: { type: 'integer', default: 0, description: 'Output tokens.' },
      cacheReadTokens: { type: 'integer', default: 0, description: 'Cache-hit read tokens.' },
      cacheWriteTokens: { type: 'integer', default: 0, description: 'Cache-write tokens.' },
      ts: { type: 'string', description: 'ISO 8601 timestamp. Defaults to now.' },
    },
  },
  output: makeOutput(),
  async execute(args, _exec): Promise<RecordCostValue> {
    const a = args as RecordCostArgs
    const ctx = toolContext!
    const price = resolvePrice(a.model, ctx.config.pricing)
    const cost = price
      ? computeCost(
          price,
          a.inputTokens ?? 0,
          a.outputTokens ?? 0,
          a.cacheReadTokens ?? 0,
          a.cacheWriteTokens ?? 0,
        )
      : 0
    const id = ctx.ledger.insert({
      ts: a.ts ?? new Date().toISOString(),
      sessionId: ctx.sessionId,
      project: ctx.project,
      provider: a.provider ?? null,
      model: a.model,
      inputTokens: a.inputTokens ?? 0,
      outputTokens: a.outputTokens ?? 0,
      cacheReadTokens: a.cacheReadTokens ?? 0,
      cacheWriteTokens: a.cacheWriteTokens ?? 0,
      cost,
    })
    return { id, cost }
  },
}

// --- query_cost ------------------------------------------------------------

export interface QueryCostArgs {
  range?: string
}

export interface QueryCostValue {
  totalCost: number
  totalCalls: number
  byModel: UsageSummary[]
  /** Global daily budget from config.defaultDailyBudget, when set. */
  budget?: {
    label: string
    limit: number
    window: string
    spent: number
    remaining: number
    exceeded: boolean
  }
  /** Budgets created via set_budget, with current-window spend status. */
  budgets?: {
    label: string
    limit: number
    window: string
    spent: number
    remaining: number
    exceeded: boolean
  }[]
}

export const queryCostTool: ToolDefinition = {
  name: 'query_cost',
  description:
    'Query the persistent cost ledger: total spend and per-model breakdown within a time range. ' +
    'Accepts "today" / "week" / "month" / "all" / an ISO timestamp as the range. ' +
    'Also reports current daily-budget status if one is set.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      range: {
        type: 'string',
        description: 'Time range: "today" | "week" | "month" | "all" | ISO 8601 timestamp. Defaults to "all".',
        default: 'all',
      },
    },
  },
  output: makeOutput(),
  async execute(args, _exec): Promise<QueryCostValue> {
    const a = args as QueryCostArgs
    const ctx = toolContext!
    const priceResolver = (model: string) => resolvePrice(model, ctx.config.pricing)
    const since = resolveSince(a.range ?? 'all')
    const byModel = ctx.ledger.summaryByModel(since, undefined, priceResolver)
    const totalCost = byModel.reduce((s, m) => s + m.cost, 0)
    const totalCalls = byModel.reduce((s, m) => s + m.calls, 0)

    // Global daily budget (from config), recomputed via the same priceResolver.
    let budget: QueryCostValue['budget']
    const limit = ctx.config.defaultDailyBudget
    if (limit > 0) {
      const spent = ctx.ledger.spentSince(resolveSince('today')!, undefined, priceResolver)
      budget = {
        label: 'daily',
        limit,
        window: 'daily',
        spent,
        remaining: Math.max(0, limit - spent),
        exceeded: spent >= limit,
      }
    }

    // Budgets created via set_budget, each with its own window's current spend.
    const budgets: QueryCostValue['budgets'] = ctx.ledger
      .listBudgets()
      .map((b) => {
        const windowSince = resolveSince(b.window) ?? new Date(0).toISOString()
        const model = b.label.startsWith('model:') ? b.label.slice('model:'.length) : undefined
        const spent = ctx.ledger.spentSince(windowSince, model, priceResolver)
        return {
          label: b.label,
          limit: b.limit,
          window: b.window,
          spent,
          remaining: Math.max(0, b.limit - spent),
          exceeded: spent >= b.limit,
        }
      })

    return { totalCost, totalCalls, byModel, ...(budget ? { budget } : {}), budgets }
  },
}

// --- set_budget ------------------------------------------------------------

export interface SetBudgetArgs {
  label: string
  limit: number
  window?: 'never' | 'daily' | 'weekly' | 'monthly'
  remove?: boolean
}

export interface SetBudgetValue {
  label: string
  limit: number
  window: string
  spent: number
  remaining: number
  exceeded: boolean
  removed?: boolean
}

export const setBudgetTool: ToolDefinition = {
  name: 'set_budget',
  description:
    'Create, update, or remove a spending budget and report current spend within its window. ' +
    'Labels can be "daily" (global), "model:<name>", or "project:<name>". ' +
    'Set remove=true to delete a budget.',
  parameters: {
    type: 'object',
    required: ['label', 'limit'],
    additionalProperties: false,
    properties: {
      label: { type: 'string', description: 'Budget label, e.g. "daily", "model:deepseek-reasoner".' },
      limit: { type: 'number', description: 'CNY ceiling (non-negative).' },
      window: {
        type: 'string',
        enum: ['never', 'daily', 'weekly', 'monthly'],
        default: 'never',
        description: 'Reset cadence.',
      },
      remove: { type: 'boolean', default: false, description: 'If true, delete this budget.' },
    },
  },
  output: makeOutput(),
  async execute(args, _exec): Promise<SetBudgetValue> {
    const a = args as SetBudgetArgs
    const ctx = toolContext!
    if (a.remove) {
      ctx.ledger.removeBudget(a.label)
      return {
        label: a.label,
        limit: 0,
        window: 'never',
        spent: 0,
        remaining: 0,
        exceeded: false,
        removed: true,
      }
    }
    const row: BudgetRow = {
      label: a.label,
      limit: a.limit,
      window: a.window ?? 'never',
    }
    ctx.ledger.setBudget(row)
    const since = resolveSince(row.window) ?? new Date(0).toISOString()
    const model = a.label.startsWith('model:') ? a.label.slice('model:'.length) : undefined
    const spent = ctx.ledger.spentSince(since, model, (m) => resolvePrice(m, ctx.config.pricing))
    return {
      label: row.label,
      limit: row.limit,
      window: row.window,
      spent,
      remaining: Math.max(0, row.limit - spent),
      exceeded: spent >= row.limit,
    }
  },
}

// ---------------------------------------------------------------------------
// Registration adapter: the host sets the live tool context (ledger + config)
// before registering tools, so handlers can close over it.
// ---------------------------------------------------------------------------

let toolContext: ToolContext | null = null

export function setToolContext(ctx: ToolContext): void {
  toolContext = ctx
}

export const ALL_TOOLS: ToolDefinition[] = [recordCostTool, queryCostTool, setBudgetTool]
