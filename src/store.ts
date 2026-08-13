/**
 * SQLite-backed persistent ledger for LLM token usage records.
 *
 * One row = one completed LLM call (or the finest granularity the host event
 * exposes). The store is intentionally tiny: open a DB at a workspace-local
 * path, ensure the schema, and offer insert + aggregate queries.
 *
 * Windows note: better-sqlite3 ships prebuilt binaries for win32/x64, so this
 * needs no native toolchain at install time under Node 22.
 */

import BetterSqlite3 from 'better-sqlite3'
import type { Database } from 'better-sqlite3'
import { resolve } from 'node:path'
import { mkdirSync } from 'node:fs'

export interface UsageRecord {
  /** Auto-increment id (assigned on insert). */
  id?: number
  /** ISO 8601 timestamp of the LLM call. */
  ts: string
  /** DSH session id, when known from the event context. */
  sessionId: string | null
  /** Workspace/project label, when known. */
  project: string | null
  /** Provider route (e.g. "deepseek-official", "sub2api"). */
  provider: string | null
  /** Model name as reported by the harness. */
  model: string
  inputTokens: number
  outputTokens: number
  /** Tokens served from the prompt cache (cache hit). */
  cacheReadTokens: number
  /** Tokens written into the prompt cache. */
  cacheWriteTokens: number
  /** Computed cost in CNY (0 when no price is known). */
  cost: number
}

export interface BudgetRow {
  /** Free-form label, e.g. "daily", "project:foo", "model:deepseek-reasoner". */
  label: string
  /** CNY budget ceiling. */
  limit: number
  /** Reset cadence: 'never' | 'daily' | 'weekly' | 'monthly'. */
  window: string
}

/** Filter for selective cleanup. All fields optional; an empty filter deletes every row. */
export interface CleanupFilter {
  /** Delete rows with ts older than (now - N days). 0/undefined = no age limit. */
  olderThanDays?: number
  /** Delete rows with ts before this ISO timestamp. */
  beforeTs?: string
  /** Delete rows with ts after this ISO timestamp. */
  sinceTs?: string
  /** Delete rows matching this exact model name. */
  model?: string
  /** Delete rows matching this exact provider. null matches rows with no provider. */
  provider?: string | null
  /** Delete rows matching this session id. null matches rows with no session. */
  sessionId?: string | null
  /** Delete rows matching this project label. null matches rows with no project. */
  project?: string | null
}

/** Price needed to recompute cost from a token aggregate. */
export interface ModelPriceLike {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** Recompute cost (CNY) for a token aggregate given a price (per 1M tokens). */
function recost(p: ModelPriceLike, r: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }): number {
  const per = 1_000_000
  return (r.inputTokens * p.input) / per + (r.outputTokens * p.output) / per + (r.cacheReadTokens * p.cacheRead) / per + (r.cacheWriteTokens * p.cacheWrite) / per
}

export interface UsageSummary {
  model: string
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cost: number
}

export interface ProviderSummary {
  provider: string
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cost: number
}

export interface TrendPoint {
  t: string
  cost: number
  inputTokens: number
  outputTokens: number
}

export class Ledger {
  private db: Database

  constructor(dbPath: string) {
    // Ensure the parent directory exists (the path may live under a .dsh cache dir).
    const dir = resolve(dbPath, '..')
    mkdirSync(dir, { recursive: true })
    this.db = new BetterSqlite3(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.ensureSchema()
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        session_id TEXT,
        project TEXT,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        cost REAL NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage(ts);
      CREATE INDEX IF NOT EXISTS idx_usage_model ON usage(model);
      CREATE INDEX IF NOT EXISTS idx_usage_session ON usage(session_id);
      CREATE INDEX IF NOT EXISTS idx_usage_project ON usage(project);

      CREATE TABLE IF NOT EXISTS budgets (
        label TEXT PRIMARY KEY,
        "limit" REAL NOT NULL,
        window TEXT NOT NULL DEFAULT 'never'
      );
    `)
    // Migration: add provider column if missing (existing DBs predate it).
    const cols = this.db.prepare("PRAGMA table_info(usage)").all() as { name: string }[]
    if (!cols.some((c) => c.name === 'provider')) {
      this.db.exec("ALTER TABLE usage ADD COLUMN provider TEXT")
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_usage_provider ON usage(provider)")
    }
  }

  /** Insert one usage record. Uses a prepared statement for throughput. */
  insert(r: UsageRecord): number {
    const stmt = this.db.prepare(
      `INSERT INTO usage
        (ts, session_id, project, provider, model, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, cost)
       VALUES (@ts, @sessionId, @project, @provider, @model, @inputTokens, @outputTokens,
               @cacheReadTokens, @cacheWriteTokens, @cost)`,
    )
    const info = stmt.run({
      ts: r.ts,
      sessionId: r.sessionId,
      project: r.project,
      provider: r.provider ?? null,
      model: r.model,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cacheReadTokens: r.cacheReadTokens,
      cacheWriteTokens: r.cacheWriteTokens,
      cost: r.cost,
    })
    return Number(info.lastInsertRowid)
  }

  /** Aggregated usage grouped by model, optionally within a time range.
   *  Cost is recomputed at query time from the supplied priceResolver, so
   *  changing prices retroactively updates totals (stored cost is ignored). */
  summaryByModel(since?: string, until?: string, priceResolver?: (model: string) => { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; cost: number } extends never ? never : ModelPriceLike | null): UsageSummary[] {
    const where: string[] = []
    const params: Record<string, string> = {}
    if (since) { where.push('ts >= @since'); params.since = since }
    if (until) { where.push('ts <= @until'); params.until = until }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const rows = this.db
      .prepare(
        `SELECT model,
                COUNT(*) AS calls,
                COALESCE(SUM(input_tokens), 0) AS inputTokens,
                COALESCE(SUM(output_tokens), 0) AS outputTokens,
                COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
                COALESCE(SUM(cache_write_tokens), 0) AS cacheWriteTokens
           FROM usage ${clause}
          GROUP BY model`,
      )
      .all(params) as (Omit<UsageSummary, 'cost'>)[]
    // Recompute cost with current pricing; sort by recomputed cost desc.
    const withCost = rows.map((r) => {
      const p = priceResolver?.(r.model) ?? null
      const cost = p ? recost(p, r) : 0
      return { ...r, cost }
    })
    withCost.sort((a, b) => b.cost - a.cost)
    return withCost as UsageSummary[]
  }

  /** Aggregated usage grouped by provider, optionally within a time range. */
  summaryByProvider(since?: string, until?: string, priceResolver?: (model: string) => ModelPriceLike | null): ProviderSummary[] {
    const where: string[] = []
    const params: Record<string, string> = {}
    if (since) { where.push('ts >= @since'); params.since = since }
    if (until) { where.push('ts <= @until'); params.until = until }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    // Group by provider, but cost needs per-model pricing → compute via a
    // model-grouped subquery then sum into providers.
    const modelRows = this.db
      .prepare(
        `SELECT COALESCE(provider, '历史记录') AS provider,
                model,
                COUNT(*) AS calls,
                COALESCE(SUM(input_tokens), 0) AS inputTokens,
                COALESCE(SUM(output_tokens), 0) AS outputTokens,
                COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
                COALESCE(SUM(cache_write_tokens), 0) AS cacheWriteTokens
           FROM usage ${clause}
          GROUP BY provider, model`,
      )
      .all(params) as { provider: string; model: string; calls: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }[]
    const byProv = new Map<string, ProviderSummary>()
    for (const r of modelRows) {
      const p = priceResolver?.(r.model) ?? null
      const cost = p ? recost(p, r) : 0
      const cur = byProv.get(r.provider) ?? { provider: r.provider, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 }
      cur.calls += r.calls
      cur.inputTokens += r.inputTokens
      cur.outputTokens += r.outputTokens
      cur.cacheReadTokens += r.cacheReadTokens
      cur.cacheWriteTokens += r.cacheWriteTokens
      cur.cost += cost
      byProv.set(r.provider, cur)
    }
    return [...byProv.values()].sort((a, b) => b.cost - a.cost)
  }

  /** Recent records (most recent first), with provider. */
  recent(limit = 50): UsageRecord[] {
    return this.db
      .prepare(
        `SELECT id, ts, session_id AS sessionId, project, provider, model,
                input_tokens AS inputTokens, output_tokens AS outputTokens,
                cache_read_tokens AS cacheReadTokens,
                cache_write_tokens AS cacheWriteTokens, cost
           FROM usage
          ORDER BY id DESC
          LIMIT @limit`,
      )
      .all({ limit }) as UsageRecord[]
  }

  /** Time-bucketed cumulative cost + tokens for trend charts.
   *  Buckets are ~24 evenly spaced points across the [since, now] range. */
  trend(since?: string): TrendPoint[] {
    const sinceTs = since ?? new Date(0).toISOString()
    const rows = this.db
      .prepare(
        `SELECT ts, cost, input_tokens + cache_read_tokens + cache_write_tokens AS inputTok,
                output_tokens AS outputTok
           FROM usage
          WHERE ts >= @since
          ORDER BY ts ASC`,
      )
      .all({ since: sinceTs }) as { ts: string; cost: number; inputTok: number; outputTok: number }[]
    if (rows.length === 0) return []
    const start = new Date(rows[0].ts).getTime()
    const end = Date.now()
    const span = Math.max(1, end - start)
    const BUCKETS = 24
    const buckets: TrendPoint[] = Array.from({ length: BUCKETS }, (_, i) => ({
      t: new Date(start + (span * i) / (BUCKETS - 1)).toISOString(),
      cost: 0, inputTokens: 0, outputTokens: 0,
    }))
    let cumCost = 0, cumIn = 0, cumOut = 0
    for (const r of rows) {
      const t = new Date(r.ts).getTime()
      const idx = Math.min(BUCKETS - 1, Math.max(0, Math.floor(((t - start) / span) * (BUCKETS - 1))))
      cumCost += r.cost
      cumIn += r.inputTok
      cumOut += r.outputTok
      buckets[idx].cost = cumCost
      buckets[idx].inputTokens = cumIn
      buckets[idx].outputTokens = cumOut
    }
    // Forward-fill trailing buckets with last cumulative value so the line is continuous.
    let last: TrendPoint | undefined
    for (const b of buckets) {
      if (b.cost === 0 && b.inputTokens === 0 && last) {
        b.cost = last.cost
        b.inputTokens = last.inputTokens
        b.outputTokens = last.outputTokens
      }
      last = b
    }
    return buckets
  }

  /**
   * Total cost across all records within an optional range.
   *
   * Cost is recomputed at query time from the supplied priceResolver, so
   * changing prices retroactively updates totals (the stored cost column is
   * ignored) — consistent with {@link Ledger.summaryByModel} and
   * {@link Ledger.spentSince}. Without a resolver, falls back to the stored
   * cost (for legacy callers / unknown models).
   */
  totalCost(
    since?: string,
    until?: string,
    priceResolver?: (model: string) => ModelPriceLike | null,
  ): number {
    if (!priceResolver) return this.storedCostSum(since, until)
    // Recompute per-model from aggregated token sums so we share one source of
    // truth with summaryByModel (stored cost is never trusted here).
    const byModel = this.summaryByModel(since, until, priceResolver)
    return byModel.reduce((s, m) => s + m.cost, 0)
  }

  /** Sum the stored cost column directly (legacy / no-resolver path). */
  private storedCostSum(since?: string, until?: string): number {
    const where: string[] = []
    const params: Record<string, string> = {}
    if (since) {
      where.push('ts >= @since')
      params.since = since
    }
    if (until) {
      where.push('ts <= @until')
      params.until = until
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(cost), 0) AS cost FROM usage ${clause}`)
      .get(params) as { cost: number }
    return row.cost
  }

  /**
   * Cost spent within the current window for a budget label. Recomputed from the
   * supplied priceResolver so budget status and {@link query_cost} totals stay
   * on the same number after a price change (the stored cost column is ignored).
   */
  spentSince(since: string, model?: string, priceResolver?: (model: string) => ModelPriceLike | null): number {
    if (!priceResolver) return this.storedSpentSince(since, model)
    // Recompute: sum per-model token costs so the model-scoped and global cases
    // share the recomputation path with summaryByModel.
    const where: string[] = ['ts >= @since']
    const params: Record<string, string> = { since }
    if (model) {
      where.push('model = @model')
      params.model = model
    }
    const clause = `WHERE ${where.join(' AND ')}`
    const rows = this.db
      .prepare(
        `SELECT model,
                COALESCE(SUM(input_tokens), 0) AS inputTokens,
                COALESCE(SUM(output_tokens), 0) AS outputTokens,
                COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
                COALESCE(SUM(cache_write_tokens), 0) AS cacheWriteTokens
           FROM usage ${clause}
          GROUP BY model`,
      )
      .all(params) as { model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }[]
    let total = 0
    for (const r of rows) {
      const p = priceResolver(r.model)
      if (p) total += recost(p, r)
    }
    return total
  }

  /** Sum the stored cost column directly (legacy / no-resolver path). */
  private storedSpentSince(since: string, model?: string): number {
    if (model) {
      const row = this.db
        .prepare(
          `SELECT COALESCE(SUM(cost), 0) AS cost FROM usage
            WHERE ts >= @since AND model = @model`,
        )
        .get({ since, model }) as { cost: number }
      return row.cost
    }
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(cost), 0) AS cost FROM usage WHERE ts >= @since`)
      .get({ since }) as { cost: number }
    return row.cost
  }

  // --- budgets -----------------------------------------------------------

  setBudget(b: BudgetRow): void {
    this.db
      .prepare(
        `INSERT INTO budgets (label, "limit", window)
         VALUES (@label, @limit, @window)
         ON CONFLICT(label) DO UPDATE SET
           "limit" = excluded."limit",
           window = excluded.window`,
      )
      .run({ label: b.label, limit: b.limit, window: b.window })
  }

  getBudget(label: string): BudgetRow | undefined {
    return this.db
      .prepare(`SELECT label, "limit", window FROM budgets WHERE label = @label`)
      .get({ label }) as BudgetRow | undefined
  }

  listBudgets(): BudgetRow[] {
    return this.db
      .prepare(`SELECT label, "limit", window FROM budgets ORDER BY label`)
      .all() as BudgetRow[]
  }

  removeBudget(label: string): void {
    this.db.prepare(`DELETE FROM budgets WHERE label = @label`).run({ label })
  }

  /** Delete records older than `days` days. Returns number deleted. */
  cleanupOlderThan(days: number): number {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString()
    const info = this.db.prepare(`DELETE FROM usage WHERE ts < @cutoff`).run({ cutoff })
    return Number(info.changes)
  }

  /**
   * Delete usage rows matching an optional filter. With no filter fields set,
   * deletes EVERYTHING (full clear). Returns the number of rows deleted.
   */
  cleanup(filter: CleanupFilter = {}): number {
    const where: string[] = []
    const params: Record<string, string | number | null> = {}
    if (filter.olderThanDays && filter.olderThanDays > 0) {
      where.push('ts < @cutoff')
      params.cutoff = new Date(Date.now() - filter.olderThanDays * 86400000).toISOString()
    }
    if (filter.beforeTs) { where.push('ts <= @beforeTs'); params.beforeTs = filter.beforeTs }
    if (filter.sinceTs) { where.push('ts >= @sinceTs'); params.sinceTs = filter.sinceTs }
    if (filter.model) { where.push('model = @model'); params.model = filter.model }
    if (filter.provider !== undefined) {
      where.push(filter.provider === null ? 'provider IS NULL' : 'provider = @provider')
      if (filter.provider !== null) params.provider = filter.provider
    }
    if (filter.sessionId !== undefined) {
      where.push(filter.sessionId === null ? 'session_id IS NULL' : 'session_id = @sessionId')
      if (filter.sessionId !== null) params.sessionId = filter.sessionId
    }
    if (filter.project !== undefined) {
      where.push(filter.project === null ? 'project IS NULL' : 'project = @project')
      if (filter.project !== null) params.project = filter.project
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const info = this.db.prepare(`DELETE FROM usage ${clause}`).run(params)
    return Number(info.changes)
  }

  /** Distinct values present in the DB, for the cleanup filter dropdowns. */
  cleanupFilterOptions(): {
    models: string[]
    providers: (string | null)[]
    sessions: (string | null)[]
    projects: (string | null)[]
  } {
    const q = (expr: string) =>
      this.db.prepare(`SELECT DISTINCT ${expr} AS v FROM usage ORDER BY v`).all() as { v: string | null }[]
    return {
      models: q('model').map((r) => r.v ?? ''),
      providers: q('provider').map((r) => r.v),
      sessions: q('session_id').map((r) => r.v),
      projects: q('project').map((r) => r.v),
    }
  }

  /** Total record count (for settings display). */
  count(): number {
    return Number((this.db.prepare(`SELECT COUNT(*) AS c FROM usage`).get() as { c: number }).c)
  }

  close(): void {
    this.db.close()
  }
}
