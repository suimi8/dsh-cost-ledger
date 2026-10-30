/**
 * Standalone self-test for the ledger data layer.
 * Run with: pnpm exec tsx scripts/selftest.ts
 *
 * Verifies store + pricing + tool handlers end-to-end, without the DSH host.
 * Tools now read a shared ToolContext (set via setToolContext) and are async,
 * matching the real ToolDefinition.execute contract.
 */

import { Ledger } from '../src/store.ts'
import { resolvePrice, computeCost } from '../src/pricing.ts'
import {
  recordCostTool,
  queryCostTool,
  setBudgetTool,
  setToolContext,
  type RecordCostValue,
  type QueryCostValue,
  type SetBudgetValue,
} from '../src/tools.ts'
import type { CostLedgerConfig } from '../src/config.ts'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'
import assert from 'node:assert'

const dbPath = resolve(import.meta.dirname, '..', 'tmp-selftest.db')
for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) rmSync(f, { force: true })

const ledger = new Ledger(dbPath)
const config: CostLedgerConfig = {
  dbPath: 'tmp-selftest.db',
  pricing: {},
  defaultDailyBudget: 1.0, // 1 CNY daily budget to test the budget warning path
  cleanupDays: 0,
}

// Inject the shared tool context the handlers close over.
setToolContext({
  ledger,
  config,
  sessionId: 'sess-test',
  project: 'proj-test',
})

let passed = 0
function check(name: string, cond: boolean) {
  assert.ok(cond, `FAIL: ${name}`)
  passed++
  console.log(`  ✓ ${name}`)
}

// 1. Pricing built-in.
const price = resolvePrice('deepseek-chat')
check('deepseek-chat price resolved', price !== null)
check('deepseek-chat input=2', price!.input === 2)

// 2. Prefix matching (variant model name).
const variant = resolvePrice('deepseek-chat-20250120')
check('variant model matches by prefix', variant !== null && variant.input === 2)

// 3. Unknown model -> null.
check('unknown model returns null', resolvePrice('gpt-4o') === null)

// 4. computeCost math: 1M input + 1M output of deepseek-chat = 2 + 8 = 10 CNY.
const cost = computeCost(price!, 1_000_000, 1_000_000, 0, 0)
check('computeCost 1M/1M = 10 CNY', Math.abs(cost - 10) < 1e-9)

// 5. record_cost tool: 500K input + 200K output of deepseek-chat.
//    cost = 0.5M*2 + 0.2M*8 = 1 + 1.6 = 2.6 CNY
const rec = (await recordCostTool.execute(
  { model: 'deepseek-chat', inputTokens: 500_000, outputTokens: 200_000 },
  { arguments: {}, signal: new AbortController().signal },
)) as RecordCostValue
check('record_cost returns id', rec.id > 0)
check('record_cost computed cost = 2.6', Math.abs(rec.cost - 2.6) < 1e-9)

// 6. record another call on deepseek-reasoner: 100K input + 50K output.
//    cost = 0.1M*4 + 0.05M*16 = 0.4 + 0.8 = 1.2 CNY
const rec2 = (await recordCostTool.execute(
  { model: 'deepseek-reasoner', inputTokens: 100_000, outputTokens: 50_000 },
  { arguments: {}, signal: new AbortController().signal },
)) as RecordCostValue
check('record_cost reasoner id', rec2.id > rec.id)
check('record_cost reasoner cost = 1.2', Math.abs(rec2.cost - 1.2) < 1e-9)

// 7. record an unknown model -> cost 0, still counted.
const rec3 = (await recordCostTool.execute(
  { model: 'gpt-4o', inputTokens: 1_000, outputTokens: 1_000 },
  { arguments: {}, signal: new AbortController().signal },
)) as RecordCostValue
check('unknown model cost = 0', rec3.cost === 0)

// 8. query_cost (all): total = 2.6 + 1.2 + 0 = 3.8
const qAll = (await queryCostTool.execute({}, { arguments: {}, signal: new AbortController().signal })) as QueryCostValue
check('query total cost = 3.8', Math.abs(qAll.totalCost - 3.8) < 1e-9)
check('query total calls = 3', qAll.totalCalls === 3)
check('query byModel has 3 entries', qAll.byModel.length === 3)
check('query byModel sorted by cost desc (deepseek-chat first)', qAll.byModel[0].model === 'deepseek-chat')

// 9. budget: default daily = 1.0 CNY, spent 3.8 -> exceeded.
check('daily budget exceeded', qAll.budget !== undefined && qAll.budget.exceeded === true)
check('daily budget spent = 3.8', qAll.budget !== undefined && Math.abs(qAll.budget.spent - 3.8) < 1e-9)

// 10. set_budget: model-scoped budget for deepseek-reasoner, limit 2.0, window daily.
const sb = (await setBudgetTool.execute(
  { label: 'model:deepseek-reasoner', limit: 2.0, window: 'daily' },
  { arguments: {}, signal: new AbortController().signal },
)) as SetBudgetValue
check('set_budget returns spent for reasoner = 1.2', Math.abs(sb.spent - 1.2) < 1e-9)
check('set_budget remaining = 0.8', Math.abs(sb.remaining - 0.8) < 1e-9)
check('set_budget not exceeded', sb.exceeded === false)

// 11. set_budget remove.
const rm = (await setBudgetTool.execute(
  { label: 'model:deepseek-reasoner', limit: 0, remove: true },
  { arguments: {}, signal: new AbortController().signal },
)) as SetBudgetValue
check('set_budget removed', rm.removed === true)
check('budget row gone after remove', ledger.listBudgets().find((b) => b.label === 'model:deepseek-reasoner') === undefined)

// 12. query_cost range=today still sees everything (inserted moments ago).
const qToday = (await queryCostTool.execute(
  { range: 'today' },
  { arguments: {}, signal: new AbortController().signal },
)) as QueryCostValue
check('query today total = 3.8', Math.abs(qToday.totalCost - 3.8) < 1e-9)

// 13. recent() returns rows newest-first.
const recent = ledger.recent(10)
check('recent returns 3 rows', recent.length === 3)
check('recent newest first (gpt-4o)', recent[0].model === 'gpt-4o')

// 14. session/project label persisted from toolCtx.
check('session label persisted', recent[2].sessionId === 'sess-test')
check('project label persisted', recent[2].project === 'proj-test')

// 15. output.render projects the value to a text content block.
const rendered = recordCostTool.output.render({}, rec as any)
check('render returns a text block', Array.isArray(rendered) && rendered[0].type === 'text')
check('render text is valid JSON', typeof JSON.parse((rendered[0] as any).text) === 'object')

// 16. DeepSeek V4 pricing: cacheRead is MUCH cheaper than input (official page).
const v4 = resolvePrice('deepseek-v4-flash')!
check('v4-flash price resolved', v4 !== null)
check('v4-flash input=1 (CNY)', v4.input === 1)
check('v4-flash output=2', v4.output === 2)
check('v4-flash cacheRead=0.02', v4.cacheRead === 0.02)
check('v4-flash cacheRead cheaper than input', v4.cacheRead < v4.input)
check('v4-pro cacheRead=0.025 cheaper than input 3', resolvePrice('deepseek-v4-pro')!.cacheRead < 3)

// 17. Longest-prefix wins among built-in keys: a model like 'deepseek-chat'
// matches the specific built-in entry, and a hypothetical shorter built-in key
// would not shadow it. We verify the exact-entry path returns the right price.
check('built-in exact entry wins (deepseek-chat input=2)', resolvePrice('deepseek-chat')!.input === 2)
check('built-in prefix match returns correct price (deepseek-chat-v2)', resolvePrice('deepseek-chat-v2')!.input === 2)
// An override always wins over the built-in table (user config is authoritative).
const overridePricing = { 'deepseek': { input: 99, output: 99, cacheRead: 99, cacheWrite: 99 } }
check('override prefix matches unknown model', resolvePrice('deepseek-xyz', overridePricing)!.input === 99)
check('override exact match wins over built-in', resolvePrice('deepseek-chat', overridePricing)!.input === 99)

// 18. Cost accounting consistency: query_cost and spentSince share one number.
// Insert a deepseek-chat call, then confirm summaryByModel total == spentSince.
ledger.insert({ ts: new Date().toISOString(), sessionId: null, project: null, provider: null,
  model: 'deepseek-chat', inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 999 })
const qAll2 = (await queryCostTool.execute({}, { arguments: {}, signal: new AbortController().signal })) as QueryCostValue
const todaySince = (function () { const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString() })()
const spentToday = ledger.spentSince(todaySince, undefined, (m) => resolvePrice(m, config.pricing))
check('query total matches recomputed spentSince', Math.abs(qAll2.totalCost - spentToday) < 1e-9)
check('recomputed cost ignores stored cost column', qAll2.totalCost < 999)

// 19. query_cost reports budgets created via set_budget.
await setBudgetTool.execute({ label: 'model:deepseek-reasoner', limit: 0.5, window: 'never' }, { arguments: {}, signal: new AbortController().signal })
const qWithBudget = (await queryCostTool.execute({}, { arguments: {}, signal: new AbortController().signal })) as QueryCostValue
check('query_cost reports set_budget budgets', Array.isArray(qWithBudget.budgets) && qWithBudget.budgets!.some((b) => b.label === 'model:deepseek-reasoner'))
await setBudgetTool.execute({ label: 'model:deepseek-reasoner', limit: 0, remove: true }, { arguments: {}, signal: new AbortController().signal })

// 20. resolvePrice edge cases: empty model returns null; glm-5-2 default is 0.
check('empty model name returns null', resolvePrice('') === null)
check('glm-5-2 default price is 0 (override in config)', resolvePrice('glm-5-2')!.input === 0)

ledger.close()
for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) rmSync(f, { force: true })

console.log(`\n✅ All ${passed} checks passed.`)
