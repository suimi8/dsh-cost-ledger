/**
 * Plugin configuration schema for dsh-cost-ledger.
 *
 * Declared with Schema (schemastery), which is the Cordis-native config DSL.
 * Users edit these values under the WebUI plugin config panel; defaults are
 * applied for any field left unset.
 */

import Schema from 'schemastery'

export interface ModelPriceConfig {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface CostLedgerConfig {
  /** Where to store the SQLite ledger. Relative paths resolve under the workspace. */
  dbPath: string
  /** Per-model price overrides / additions, in CNY per 1M tokens. */
  pricing: Record<string, ModelPriceConfig>
  /** Default global daily budget ceiling in CNY. 0 = no limit. */
  defaultDailyBudget: number
  /** Auto-clean records older than this many days on plugin load. 0 = disabled. */
  cleanupDays: number
}

export const CostLedgerConfig = Schema.intersect([
  Schema.object({
    dbPath: Schema.string()
      .description('SQLite ledger file path. Relative paths resolve under the DSH home/cache dir.')
      .default('dsh-cost-ledger/ledger.db'),
    defaultDailyBudget: Schema.number()
      .min(0)
      .description('Default daily budget ceiling in CNY. 0 means no limit.')
      .default(0),
    cleanupDays: Schema.number()
      .min(0)
      .description('Auto-clean records older than this many days on load. 0 = disabled.')
      .default(0),
  }),
  Schema.object({
    pricing: Schema.dict(
      Schema.intersect([
        Schema.object({
          input: Schema.number().min(0).description('CNY per 1M input tokens').default(0),
          output: Schema.number().min(0).description('CNY per 1M output tokens').default(0),
        }),
        Schema.object({
          cacheRead: Schema.number().min(0).description('CNY per 1M cache-hit read tokens').default(0),
          cacheWrite: Schema.number().min(0).description('CNY per 1M cache-write tokens').default(0),
        }),
      ]),
    ).description('Per-model price overrides (CNY per 1M tokens). Keys are model name prefixes.'),
  }),
]).i18n({
  'zh-CN': {
    dbPath: 'SQLite 账本文件路径。相对路径基于 DSH home/cache 目录。',
    defaultDailyBudget: '默认每日预算上限(元)。0 表示不限。',
    cleanupDays: '加载时自动清理超过 N 天的记录。0 = 禁用。',
    pricing: '按模型的单价覆盖(元/百万 token)。键为模型名前缀。',
  },
}) as Schema<CostLedgerConfig>

// Default config instance used when nothing is configured.
export const defaultConfig: CostLedgerConfig = {
  dbPath: 'dsh-cost-ledger/ledger.db',
  pricing: {},
  defaultDailyBudget: 0,
  cleanupDays: 0,
}
