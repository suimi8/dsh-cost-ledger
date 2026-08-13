/**
 * dsh-cost-ledger — Cross-session persistent cost ledger for DeepSeek Harness.
 *
 * Phase 1 (host side):
 *  - Subscribes to the `llm/stream` Cordis waterfall and records every LLM
 *    call's token usage to SQLite.
 *  - Registers three agent tools (record_cost / query_cost / set_budget) via
 *    the real ToolRuntime.register(ToolDefinition) API.
 *  - Built-in DeepSeek pricing, overridable via plugin config.
 *
 * Token source (confirmed from DSH source — packages/llm/llm/src/index.ts):
 *   ctx.on('llm/stream', (options, next) => AsyncIterable<StreamChunk>)
 * `llm/stream` is a waterfall middleware wrapping EVERY streaming model call
 * (including retries). The listener must call `next()` to reach the adapter's
 * stream, then transparently forward chunks while harvesting the `usage` chunk
 * (type: 'usage'), which carries the TokenUsage we bill on.
 *
 * Billing notes (from official TokenUsage docs):
 *  - inputTokens is UNCACHED input; billed input = input + cacheRead + cacheWrite.
 *  - reasoningTokens is already included in outputTokens — never double-count.
 *  - usage is not guaranteed on every call (early abort/error) — handle absence.
 *
 * The LLM/Tools type mirrors declared below are field-for-field identical to
 * @deepseek-ai/dsh-llm / dsh-tools / dsh-session. They are declared locally
 * only because those host-injected packages are unpublished (not resolvable at
 * install time); swap for `import type` once the host publishes them.
 */

import { resolve } from 'node:path'
import { Ledger } from './store.ts'
import { CostLedgerConfig } from './config.ts'
import type { CostLedgerConfig as ConfigType } from './config.ts'
import { recordCostTool, queryCostTool, setBudgetTool, setToolContext } from './tools.ts'
import { registerHttpApi } from './api.ts'
import { resolvePrice, computeCost } from './pricing.ts'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'

import type { Context } from '@deepseek-ai/cordis'

/** Settings namespace for cost-ledger (matches the browser-side card). */
export const COST_LEDGER_NS = settingsNamespace('cost-ledger')

// ---------------------------------------------------------------------------
// SDK-shape type mirrors (see @deepseek-ai/dsh-llm / dsh-tools)
// ---------------------------------------------------------------------------

export interface GenerateOptions {
  provider: string
  model: string
  reasoningEffort?: string
  messages: unknown[]
  system?: string
  tools?: unknown[]
  temperature?: number
  maxTokens?: number
  stop?: string[]
  signal?: AbortSignal
  sessionId?: string
  purpose?: 'compaction' | 'session-title'
}

export interface TokenUsage {
  /** Uncached input tokens (billed input = input + cacheRead + cacheWrite). */
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  /** Already included in outputTokens — do not double-count. */
  reasoningTokens?: number
}

export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: string }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: string; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: unknown }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: string; replayState?: unknown }

// ---------------------------------------------------------------------------

export const name = 'cost-ledger'

// `llm` to observe token usage via llm/stream; `tools` to register agent tools.
export const inject = ['llm', 'tools']

export const Config = CostLedgerConfig

/**
 * Attach the llm/stream waterfall listener that records token usage.
 *
 * Confirmed API: ctx.on('llm/stream', (options, next) => AsyncIterable<StreamChunk>).
 * We yield the underlying stream through unchanged, harvesting the `usage`
 * chunk on the way; once the stream ends (normal/error/abort), we persist
 * one record. Retries fire separate llm/stream calls — each gets its own row.
 */
function attachTokenListener(
  ctx: Context,
  ledger: Ledger,
  getConfig: () => ConfigType,
  contextOf: () => { sessionId: string | null; project: string | null },
): void {
  const ctxAny = ctx as unknown as {
    on?: (
      event: 'llm/stream',
      handler: (
        options: GenerateOptions,
        next: () => AsyncIterable<StreamChunk>,
      ) => AsyncIterable<StreamChunk>,
      options?: { global?: boolean; prepend?: boolean },
    ) => () => void
  }

  if (typeof ctxAny.on !== 'function') {
    ctx.logger?.warn?.(
      '[cost-ledger] ctx.on unavailable; automatic token logging disabled. ' +
        'Tools record_cost/query_cost/set_budget remain available.',
    )
    return
  }

  const dispose = ctxAny.on(
    'llm/stream',
    (options, next): AsyncIterable<StreamChunk> => {
      return (async function* (): AsyncIterable<StreamChunk> {
        let usage: TokenUsage | undefined
        const iter = next()[Symbol.asyncIterator]()
        try {
          while (true) {
            const item = await iter.next()
            if (item.done) break
            if (item.value.type === 'usage') usage = item.value.usage
            yield item.value
          }
        } finally {
          if (usage !== undefined) {
            try {
              record(options, usage)
            } catch (err) {
              ctx.logger?.warn?.(`[cost-ledger] failed to record usage: ${String(err)}`)
            }
          } else if (options.model) {
            ctx.logger?.debug?.(`[cost-ledger] no usage chunk for ${options.model}`)
          }
        }
      })()
    },
    // global: observe llm/stream calls from ALL fibers/scopes, not just this
    // plugin's own context — the agent loop dispatches from a different scope.
    { global: true },
  )

  ctx.effect(() => dispose)
  ctx.logger?.info?.('[cost-ledger] attached llm/stream listener')

  function record(options: GenerateOptions, usage: TokenUsage): void {
    const price = resolvePrice(options.model, getConfig().pricing)
    const inputTokens = usage.inputTokens ?? 0
    const outputTokens = usage.outputTokens ?? 0
    const cacheReadTokens = usage.cacheReadTokens ?? 0
    const cacheWriteTokens = usage.cacheWriteTokens ?? 0
    const cost = price
      ? computeCost(price, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens)
      : 0
    const { sessionId, project } = contextOf()
    ledger.insert({
      ts: new Date().toISOString(),
      sessionId: options.sessionId ?? sessionId,
      project,
      provider: options.provider ?? null,
      model: options.model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      cost,
    })
  }
}

/**
 * Register the three agent tools via the real ToolRuntime.register(ToolDefinition).
 *
 * ToolDefinition is the host's own shape (see src/tools.ts), so we pass each
 * tool object directly. The ledger/config context is shared with handlers via
 * setToolContext() so the tool bodies can close over it.
 */
function registerTools(
  ctx: Context,
  ledger: Ledger,
  getConfig: () => ConfigType,
  contextOf: () => { sessionId: string | null; project: string | null },
): void {
  setToolContext({
    ledger,
    get config() {
      return getConfig()
    },
    get sessionId() {
      return contextOf().sessionId
    },
    get project() {
      return contextOf().project
    },
  })

  const tools = (ctx as any).tools as unknown as {
    register?: (def: unknown) => () => void
  }

  if (typeof tools.register === 'function') {
    const dispose1 = tools.register(recordCostTool)
    const dispose2 = tools.register(queryCostTool)
    const dispose3 = tools.register(setBudgetTool)
    ctx.effect(() => () => {
      dispose1?.()
      dispose2?.()
      dispose3?.()
    })
    ctx.logger?.info?.('[cost-ledger] registered 3 tools via ctx.tools.register()')
  } else {
    ctx.logger?.warn?.('[cost-ledger] ctx.tools.register not found; tools not registered.')
  }
}

export function apply(ctx: Context, config: ConfigType) {
  // Resolve the DB path once (the DB cannot move after open). Relative paths
  // anchor to the DSH process CWD (workspace root under `dsh web`).
  const dbPath = resolve(process.cwd(), config.dbPath)
  const ledger = new Ledger(dbPath)

  ctx.logger?.info?.(`[cost-ledger] ledger at ${dbPath}`)

  // Auto-clean old records on load if configured (cleanupDays > 0).
  if ((config.cleanupDays ?? 0) > 0) {
    const deleted = ledger.cleanupOlderThan(config.cleanupDays)
    if (deleted > 0) ctx.logger?.info?.(`[cost-ledger] auto-cleaned ${deleted} records older than ${config.cleanupDays}d`)
  }

  // Dynamic config source: starts as the composition entry, then tracks the
  // user settings namespace once installSettingsSection attaches a scope.
  // pricing/defaultDailyBudget become hot-editable via the WebUI settings card;
  // dbPath is fixed (taken from the initial entry above).
  let current: () => ConfigType = () => config

  installSettingsSection<ConfigType>(ctx, COST_LEDGER_NS, CostLedgerConfig, config, {
    setSource: (source) => {
      current = () => {
        const v = source()
        // dbPath is runtime-fixed (DB already open); pin to the entry value.
        return { ...v, dbPath: config.dbPath }
      }
    },
    onChange: () => {
      ctx.logger?.info?.('[cost-ledger] settings updated')
    },
  })

  const getConfig = () => current()

  // Runtime overrides for the HTTP config endpoint (in-drawer price editing).
  // These are applied on top of `current()` so the dashboard can tweak pricing
  // without a host restart; they are NOT persisted to the settings document
  // (use the settings card for durable changes). Cleared on plugin reload.
  const runtimeOverrides: { pricing?: ConfigType['pricing']; defaultDailyBudget?: number; cleanupDays?: number } = {}
  const getConfigWithOverrides = (): ConfigType => {
    const base = current()
    return {
      ...base,
      ...runtimeOverrides.pricing ? { pricing: { ...base.pricing, ...runtimeOverrides.pricing } } : {},
      ...runtimeOverrides.defaultDailyBudget !== undefined ? { defaultDailyBudget: runtimeOverrides.defaultDailyBudget } : {},
      ...runtimeOverrides.cleanupDays !== undefined ? { cleanupDays: runtimeOverrides.cleanupDays } : {},
    }
  }
  const setConfig = async (patch: Partial<ConfigType>): Promise<void> => {
    if (patch.pricing !== undefined) runtimeOverrides.pricing = patch.pricing
    if (patch.defaultDailyBudget !== undefined) runtimeOverrides.defaultDailyBudget = patch.defaultDailyBudget
    if (patch.cleanupDays !== undefined) runtimeOverrides.cleanupDays = patch.cleanupDays
  }

  // Session/project labelling. We do NOT read ctx.session/ctx.workspace
  // directly: those are services that require their own `inject` entry, and
  // accessing an uninjected service throws "cannot get property without inject".
  // The token listener already prefers the event-supplied sessionId (from
  // GenerateOptions); project is derived from the workspace cwd as a fallback.
  const contextOf = () => ({
    sessionId: null as string | null,
    project: null as string | null,
  })

  attachTokenListener(ctx, ledger, getConfigWithOverrides, contextOf)
  registerTools(ctx, ledger, getConfigWithOverrides, contextOf)

  // The default model selection (provider + model) the Agent loop uses, owned
  // by the `agentDefaultModel` service. We resolve it dynamically — the same
  // ctx.inject pattern used for webServer — so the parse-prices endpoint can
  // call ctx.llm.stream() with a concrete provider/model. Captured once the
  // service is up; null until then (the endpoint returns 503 in that window).
  let defaultModel: { provider: string; model: string } | null = null
  ;(ctx as unknown as { inject?: (deps: string[], cb: (c: any) => void) => unknown }).inject?.(
    ['agentDefaultModel'],
    (svcCtx) => {
      try {
        const svc = typeof svcCtx?.get === 'function' ? svcCtx.get('agentDefaultModel') : undefined
        if (svc && typeof svc.currentSelection === 'function') {
          const sel = svc.currentSelection()
          if (sel?.provider && sel?.model) defaultModel = { provider: sel.provider, model: sel.model }
        }
      } catch {
        /* service not yet active — stays null until it resolves */
      }
    },
  )

  // webServer is web-profile-only (headless has none). Use ctx.inject to wait
  // for it dynamically: under `dsh web` the callback runs and registers the
  // HTTP API; under headless it never runs (no panel needed there), and the
  // plugin still loads — unlike declaring `webServer` in the static `inject`,
  // which would fail the plugin under headless.
  //
  // We pass the MAIN ctx (not the webServer inject's child context): the HTTP
  // handler needs ctx.llm, which is only injectable from the main plugin
  // context (`inject = ['llm', ...]`); the child only guarantees `webServer`.
  // webServer is fetched internally via ctx.get('webServer'), which resolves
  // against the root registry regardless of which context object is passed.
  ;(ctx as unknown as { inject?: (deps: string[], cb: (c: any) => void) => unknown }).inject?.(
    ['webServer'],
    () => {
      registerHttpApi(ctx, ledger, getConfigWithOverrides, setConfig, () => defaultModel)
    },
  )

  // Close the DB cleanly on plugin unload.
  ctx.effect(() => {
    return () => {
      try {
        ledger.close()
      } catch {
        /* ignore double-close */
      }
    }
  })
}
