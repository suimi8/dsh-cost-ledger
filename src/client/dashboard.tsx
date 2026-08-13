/**
 * Cost dashboard — rich, data-driven, dynamically updated.
 *
 * Tabs: 概览 (KPI + model bars) · 模型统计 · Provider 统计 · 请求日志
 * Inline SVG bars only (no chart lib). Polls every 2s while mounted.
 * Uses dsh CSS variables to match the shell theme.
 */
import { useEffect, useState, useCallback } from 'react'
import { CostTrend, TokenDonut, BarChart } from './charts'

interface ModelRow {
  model: string
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cost: number
  unitPrice?: { input: number; output: number; cacheRead: number; cacheWrite: number }
}
interface ProviderRow {
  provider: string
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cost: number
}
interface Totals {
  totalCost: number
  totalCalls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cacheHitRate: number
}
interface Summary {
  range: string
  totals: Totals
  byModel: ModelRow[]
  budget?: { label: string; limit: number; window: string; spent: number; remaining: number; exceeded: boolean }
  pricedModels: string[]
}
interface LogRow {
  id: number
  ts: string
  sessionId: string | null
  project: string | null
  provider: string | null
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cost: number
}
interface TrendPoint { t: string; cost: number; inputTokens: number; outputTokens: number }

const RANGES = ['today', 'week', 'month', 'all'] as const
const RANGE_LABELS: Record<string, string> = { today: '今天', week: '本周', month: '本月', all: '全部' }
const PAGE_SIZES = [10, 20, 50, 100, 200] as const
type Tab = 'overview' | 'models' | 'providers' | 'logs' | 'settings'

// Shared pager state via a module-level store (simple; one dashboard instance).
let _page = 0
let _pageSize: (typeof PAGE_SIZES)[number] = 20
const pagerListeners = new Set<() => void>()
function usePager() {
  const [, force] = useState(0)
  useEffect(() => { const l = () => force((n) => n + 1); pagerListeners.add(l); return () => { pagerListeners.delete(l) } }, [])
  return {
    page: _page,
    pageSize: _pageSize,
    setPage: (p: number) => { _page = Math.max(0, p); pagerListeners.forEach((l) => l()) },
    setPageSize: (n: (typeof PAGE_SIZES)[number]) => { _pageSize = n; _page = 0; pagerListeners.forEach((l) => l()) },
  }
}

interface PluginConfig {
  dbPath?: string
  defaultDailyBudget?: number
  pricing?: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>
}

function fmt(n: number): string {
  if (n >= 1e8) return (n / 1e8).toFixed(2) + '亿'
  if (n >= 1e4) return (n / 1e4).toFixed(1) + '万'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
  return String(Math.round(n))
}
function money(n: number): string {
  if (n === 0) return '¥0.00'
  if (n < 0.01) return '¥' + n.toFixed(4)
  return '¥' + n.toFixed(2)
}
function pct(n: number): string {
  return (n * 100).toFixed(1) + '%'
}
function timeShort(ts: string): string {
  try {
    const d = new Date(ts)
    return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0') + ':' + d.getSeconds().toString().padStart(2, '0')
  } catch {
    return ts
  }
}

export function Dashboard() {
  const [summary, setSummary] = useState<Summary | null>(null)
  const [providers, setProviders] = useState<ProviderRow[]>([])
  const [logs, setLogs] = useState<LogRow[]>([])
  const [trend, setTrend] = useState<TrendPoint[]>([])
  const [range, setRange] = useState<(typeof RANGES)[number]>('all')
  const [tab, setTab] = useState<Tab>('overview')
  const [err, setErr] = useState<string | null>(null)
  const pager = usePager()
  const page = pager.page
  const pageSize = pager.pageSize

  const fetchAll = useCallback(async () => {
    try {
      const [s, p, l, tr] = await Promise.all([
        fetch(`/api/cost-ledger/summary?range=${range}`).then((r) => r.json()),
        fetch(`/api/cost-ledger/byProvider?range=${range}`).then((r) => r.json()),
        fetch(`/api/cost-ledger/logs?limit=${Math.max(pageSize, 100)}`).then((r) => r.json()),
        fetch(`/api/cost-ledger/trend?range=${range}`).then((r) => r.json()),
      ])
      setSummary(s)
      setProviders(p.byProvider ?? [])
      setLogs(l.rows ?? [])
      setTrend(tr.points ?? [])
      setErr(null)
      // NOTE: do NOT reset page here — resetting on every 2s poll causes the
      // visible "jump". Only reset when pageSize/range changes (below).
    } catch (e) {
      setErr(String(e))
    }
  }, [range, pageSize])

  // Reset to first page only when the filter actually changes (not on poll).
  useEffect(() => { pager.setPage(0) }, [range, pageSize])

  useEffect(() => {
    fetchAll()
    const t = setInterval(fetchAll, 2000)
    return () => clearInterval(t)
  }, [fetchAll])

  const t = summary?.totals
  const maxModelCost = summary ? Math.max(1, ...summary.byModel.map((m) => m.cost)) : 1
  const maxProviderCost = Math.max(1, ...providers.map((p) => p.cost))
  const totalPages = Math.max(1, Math.ceil(logs.length / pageSize))
  const pagedLogs = logs.slice(page * pageSize, page * pageSize + pageSize)
  const pagedModels = summary ? summary.byModel.slice(page * pageSize, page * pageSize + pageSize) : []

  return (
    <div style={S.wrap}>
      <div style={S.header}>
        <span style={S.title}>💰 成本账本</span>
        <div style={S.controls}>
          {(['overview', 'models', 'providers', 'logs', 'settings'] as Tab[]).map((tb) => (
            <button key={tb} onClick={() => setTab(tb)} style={tab === tb ? S.tabActive : S.tab}>
              {{ overview: '概览', models: '模型', providers: 'Provider', logs: '日志', settings: '⚙️设置' }[tb]}
            </button>
          ))}
          <select
            value={range}
            onChange={(e) => setRange(e.target.value as typeof range)}
            style={{ ...S.select, visibility: tab === 'settings' ? 'hidden' as const : 'visible' as const, flexShrink: 0 as const }}
            aria-hidden={tab === 'settings'}
          >
            {RANGES.map((r) => <option key={r} value={r}>{RANGE_LABELS[r]}</option>)}
          </select>
        </div>
      </div>

      {err && <div style={S.err}>加载失败: {err}</div>}

      {tab === 'overview' && t && (
        <>
          <div style={S.kpiGrid}>
            <Kpi label="总成本" value={money(t.totalCost)} accent />
            <Kpi label="总请求数" value={fmt(t.totalCalls)} />
            <Kpi label="缓存命中率" value={pct(t.cacheHitRate)} />
            <Kpi label="真实消耗 Tokens" value={fmt(t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens)} />
            <Kpi label="输入 Tokens" value={fmt(t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens)} sub="含缓存" />
            <Kpi label="输出 Tokens" value={fmt(t.outputTokens)} />
            <Kpi label="缓存读取" value={fmt(t.cacheReadTokens)} />
            <Kpi label="缓存写入" value={fmt(t.cacheWriteTokens)} />
          </div>

          {summary?.budget && (
            <div style={summary.budget.exceeded ? S.budgetOver : S.budget}>
              <span>预算 {money(summary.budget.spent)} / {money(summary.budget.limit)} {summary.budget.exceeded ? '⚠️ 已超支' : ''}</span>
              <Bar pct={summary.budget.spent / summary.budget.limit} color={summary.budget.exceeded ? '#e5484d' : 'var(--dsw-alias-accent,#0066cc)'} />
            </div>
          )}

          <div style={S.sectionTitle}>成本趋势</div>
          <CostTrend points={trend} />

          <div style={S.sectionTitle}>Token 分布</div>
          <TokenDonut input={t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens} output={t.outputTokens} cache={t.cacheReadTokens} />

          <div style={S.sectionTitle}>按模型成本</div>
          {summary!.byModel.length === 0 && <div style={S.empty}>暂无记录 — 发一条消息试试</div>}
          <BarChart data={summary!.byModel.map((m) => ({ label: m.model, value: m.cost, sub: `${m.calls} 次 · 未设价格${m.unitPrice ? '' : ''}` }))} />

          {summary!.pricedModels.length === 0 && <div style={S.hint}>💡 在「设置 → 插件配置 → cost-ledger」添加模型价格即可计算金额。</div>}
        </>
      )}

      {tab === 'models' && summary && (
        <>
          <Table
            head={['模型', '请求', '输入', '输出', '缓存读', '成本']}
            rows={pagedModels.map((m) => [m.model, fmt(m.calls), fmt(m.inputTokens), fmt(m.outputTokens), fmt(m.cacheReadTokens), money(m.cost)])}
          />
          <Pager total={summary.byModel.length} />
        </>
      )}

      {tab === 'providers' && (
        <>
          {providers.length === 0 ? <div style={S.empty}>暂无记录</div> : providers.map((p) => (
            <div key={p.provider} style={S.row}>
              <div style={S.rowHead}>
                <span style={S.rowName}>{p.provider}</span>
                <span style={S.rowCost}>{money(p.cost)}</span>
              </div>
              <Bar pct={p.cost / maxProviderCost} />
              <div style={S.rowMeta}>{p.calls} 次 · 输入 {fmt(p.inputTokens)} · 输出 {fmt(p.outputTokens)} · 缓存 {fmt(p.cacheReadTokens)}</div>
            </div>
          ))}
        </>
      )}

      {tab === 'logs' && (
        <>
          <div style={S.logWrap}>
            {logs.length === 0 ? <div style={S.empty}>暂无日志</div> : pagedLogs.map((l) => (
              <div key={l.id} style={S.logRow}>
                <span style={S.logTime}>{timeShort(l.ts)}</span>
                <span style={S.logModel}>{l.model}</span>
                <span style={S.logProv}>{l.provider ?? '-'}</span>
                <span style={S.logTok}>↑{fmt(l.inputTokens)} ↓{fmt(l.outputTokens)}{l.cacheReadTokens > 0 ? ` ⚡${fmt(l.cacheReadTokens)}` : ''}</span>
                <span style={S.logCost}>{money(l.cost)}</span>
              </div>
            ))}
          </div>
          <Pager total={logs.length} />
        </>
      )}
      {tab === 'settings' && (
        <SettingsPanel />
      )}
    </div>
  )
}

function Pager({ total }: { total: number }) {
  const { page, pageSize, setPage, setPageSize } = usePager()
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  return (
    <div style={S.pager}>
      <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary,#999)' }}>
        共 {total} 条 · 第 {page + 1}/{totalPages} 页
      </span>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <button style={S.pageBtn} onClick={() => setPage(Math.max(0, page - 1))} disabled={page === 0}>‹</button>
        <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value) as (typeof PAGE_SIZES)[number])} style={S.select}>
          {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}/页</option>)}
        </select>
        <button style={S.pageBtn} onClick={() => setPage(Math.min(totalPages - 1, page + 1))} disabled={page >= totalPages - 1}>›</button>
      </div>
    </div>
  )
}

function Kpi({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div style={{ ...S.kpi, ...(accent ? S.kpiAccent : {}) }}>
      <div style={S.kpiLabel}>{label}</div>
      <div style={S.kpiVal}>{value}</div>
      {sub && <div style={S.kpiSub}>{sub}</div>}
    </div>
  )
}

/** Settings panel: edit model pricing as a key-value table + AI import. */
interface PriceRow { model: string; input: string; output: string; cacheRead: string; cacheWrite: string }
function SettingsPanel() {
  const [cfg, setCfg] = useState<PluginConfig | null>(null)
  const [rows, setRows] = useState<PriceRow[]>([])
  const [budget, setBudget] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [showImport, setShowImport] = useState(false)
  const [importText, setImportText] = useState('')
  const [importing, setImporting] = useState(false)

  // Selective cleanup state.
  interface CleanupOpts { models: string[]; providers: (string | null)[]; sessions: (string | null)[]; projects: (string | null)[] }
  const [cleanupOpts, setCleanupOpts] = useState<CleanupOpts>({ models: [], providers: [], sessions: [], projects: [] })
  const [cModel, setCModel] = useState('')
  const [cProvider, setCProvider] = useState('')
  const [cSession, setCSession] = useState('')
  const [cProject, setCProject] = useState('')
  const [cDays, setCDays] = useState('')
  const [cleaning, setCleaning] = useState(false)

  const load = useCallback(async () => {
    try {
      const c: PluginConfig = await fetch('/api/cost-ledger/config').then((r) => r.json())
      setCfg(c)
      const p = c.pricing ?? {}
      setRows(Object.entries(p).map(([model, v]) => ({
        model,
        input: String(v.input ?? ''), output: String(v.output ?? ''),
        cacheRead: String(v.cacheRead ?? ''), cacheWrite: String(v.cacheWrite ?? ''),
      })))
      setBudget(String(c.defaultDailyBudget ?? 0))
      // Load cleanup filter options (distinct model/provider/session/project).
      // Non-2xx (e.g. 404 on an older host without the endpoint) yields a
      // non-array shape, so guard every field — the dropdowns just stay empty.
      try {
        const r = await fetch('/api/cost-ledger/cleanup/filters')
        if (r.ok) {
          const o = await r.json().catch(() => ({}))
          setCleanupOpts({
            models: Array.isArray(o.models) ? o.models : [],
            providers: Array.isArray(o.providers) ? o.providers : [],
            sessions: Array.isArray(o.sessions) ? o.sessions : [],
            projects: Array.isArray(o.projects) ? o.projects : [],
          })
        }
      } catch { /* ignore — cleanup still works without dropdowns */ }
    } catch (e) { setMsg(String(e)) }
  }, [])
  useEffect(() => { load() }, [load])

  const rowsToPricing = (rs: PriceRow[]): PluginConfig['pricing'] => {
    const out: PluginConfig['pricing'] = {}
    for (const r of rs) {
      const m = r.model.trim()
      if (!m) continue
      out[m] = {
        input: Number(r.input) || 0, output: Number(r.output) || 0,
        cacheRead: Number(r.cacheRead) || 0, cacheWrite: Number(r.cacheWrite) || 0,
      }
    }
    return out
  }

  const updateRow = (i: number, field: keyof PriceRow, val: string) => {
    setRows((rs) => rs.map((r, idx) => idx === i ? { ...r, [field]: val } : r))
  }
  const addRow = () => setRows((rs) => [...rs, { model: '', input: '', output: '', cacheRead: '', cacheWrite: '' }])
  const removeRow = (i: number) => setRows((rs) => rs.filter((_, idx) => idx !== i))

  // Built-in official pricing presets (元/百万 token).
  const PRESETS: Record<string, PriceRow[]> = {
    'DeepSeek V4': [
      { model: 'deepseek-v4-flash', input: '0.1', output: '3', cacheRead: '9', cacheWrite: '3' },
      { model: 'deepseek-v4-pro', input: '0.3', output: '9', cacheRead: '27', cacheWrite: '9' },
    ],
    'DeepSeek V3/R1': [
      { model: 'deepseek-chat', input: '2', output: '8', cacheRead: '0.5', cacheWrite: '8' },
      { model: 'deepseek-reasoner', input: '4', output: '16', cacheRead: '1', cacheWrite: '8' },
    ],
  }
  const applyPreset = (key: string) => {
    const preset = PRESETS[key]
    setRows((rs) => {
      const map = new Map(rs.map((r) => [r.model.trim(), r]))
      for (const p of preset) {
        const ex = map.get(p.model)
        if (ex) Object.assign(ex, p)
        else map.set(p.model, { ...p })
      }
      return [...map.values()]
    })
    setMsg(`已填入 ${key} 价格,点击保存生效`)
  }

  // AI import: send the pasted price text to the host, which calls the LLM to
  // parse free-form text (from 官网 / sub2api / newapi etc.) into structured
  // prices. Replaces the old client-side regex heuristic.
  const doImport = async () => {
    setImporting(true); setMsg(null)
    try {
      const text = importText.trim()
      if (!text) { setMsg('❌ 请粘贴价格文本'); return }
      const res = await fetch('/api/cost-ledger/parse-prices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) { setMsg('❌ ' + (j.error ?? `HTTP ${res.status}`)); return }
      const prices: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = j.prices ?? {}
      const newRows = Object.entries(prices).map(([model, v]) => ({
        model,
        input: String(v.input ?? 0),
        output: String(v.output ?? 0),
        cacheRead: String(v.cacheRead ?? 0),
        cacheWrite: String(v.cacheWrite ?? 0),
      }))
      setRows((rs) => {
        const map = new Map(rs.map((r) => [r.model.trim(), r]))
        for (const r of newRows) {
          const ex = map.get(r.model)
          if (ex) Object.assign(ex, r)
          else map.set(r.model, { ...r })
        }
        return [...map.values()]
      })
      const n = newRows.length
      setMsg(`✅ 已识别并导入 ${n} 个模型价格`)
      setShowImport(false)
      setImportText('')
    } catch (e) {
      setMsg('❌ 识别失败: ' + String(e))
    } finally { setImporting(false) }
  }

  const save = async () => {
    setSaving(true); setMsg(null)
    try {
      const pricing = rowsToPricing(rows)
      const patch: Partial<PluginConfig> = { pricing }
      const b = Number(budget)
      if (Number.isFinite(b)) patch.defaultDailyBudget = b
      const res = await fetch('/api/cost-ledger/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setMsg('✅ 已保存,新对话的 token 将按新价格计算')
    } catch (e) {
      setMsg('❌ ' + String(e))
    } finally { setSaving(false) }
  }

  /** Label for a nullable filter value in a <select>. */
  const lbl = (v: string | null, fallback = '(空)') => (v === null ? fallback : v || fallback)

  // Selective cleanup: send whichever filters the user picked. If none are set,
  // refuse (require explicit "清空全部" instead) to avoid accidental mass delete.
  const doCleanup = async (all = false) => {
    setCleaning(true); setMsg(null)
    try {
      const filter: Record<string, unknown> = {}
      if (all) {
        filter.all = true
      } else {
        if (cModel) filter.model = cModel
        if (cProvider) filter.provider = cProvider === '__null__' ? null : cProvider
        if (cSession) filter.sessionId = cSession === '__null__' ? null : cSession
        if (cProject) filter.project = cProject === '__null__' ? null : cProject
        const days = Number(cDays)
        if (cDays && Number.isFinite(days) && days > 0) filter.olderThanDays = days
      }
      if (!all && Object.keys(filter).length === 0) {
        setMsg('❌ 请至少选择一个清理条件,或点击「清空全部」')
        return
      }
      const r = await fetch('/api/cost-ledger/cleanup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(filter),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) { setMsg('❌ ' + (j.error ?? `HTTP ${r.status}`)); return }
      setMsg(`${all ? '已清空' : '已清理'} ${j.deleted} 条,剩余 ${j.remaining} 条`)
      // Refresh filter options (the picked value may now be gone).
      load()
    } catch (e) {
      setMsg('❌ ' + String(e))
    } finally { setCleaning(false) }
  }

  return (
    <div style={{ fontSize: 13 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <span style={S.sectionTitle}>模型价格 (元/百万 token)</span>
        <div style={{ display: 'flex', gap: 4 }}>
          {Object.keys(PRESETS).map((k) => (
            <button key={k} onClick={() => applyPreset(k)} style={S.presetBtn}>{k}</button>
          ))}
          <button onClick={() => setShowImport((v) => !v)} style={S.presetBtn}>🤖 AI 导入</button>
          <button onClick={addRow} style={S.presetBtn}>+ 添加</button>
        </div>
      </div>

      {showImport && (
        <div style={{ marginBottom: 8, padding: 8, background: 'var(--dsw-alias-bg-secondary,#f5f5f5)', borderRadius: 6 }}>
          <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary,#999)', marginBottom: 4 }}>
            粘贴模型 API 价格文本(任意格式,来自官网/sub2api/newapi 等),AI 会自动解析。需要先在 Agent 设置中配置默认模型。
          </div>
          <textarea value={importText} onChange={(e) => setImportText(e.target.value)} style={{ ...S.textarea, minHeight: '70px' }}
            placeholder={'例如:\nDeepSeek V4 Flash 输入 0.1元/百万,输出 3元,缓存命中 9元\nglm-5-2 输入 0.5 输出 2 缓存写入 2'} />
          <button onClick={doImport} disabled={importing} style={{ ...S.presetBtn, marginTop: 4 }}>{importing ? '识别中…' : '识别并导入'}</button>
        </div>
      )}

      {/* Key-value price table: each row = model + 4 number inputs */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr 1fr 1fr 28px', gap: '4px', fontSize: 11, alignItems: 'center' }}>
        <div style={{ fontWeight: 600, color: 'var(--dsw-alias-label-tertiary,#999)' }}>模型</div>
        <div style={{ fontWeight: 600, color: 'var(--dsw-alias-label-tertiary,#999)' }}>输入</div>
        <div style={{ fontWeight: 600, color: 'var(--dsw-alias-label-tertiary,#999)' }}>输出</div>
        <div style={{ fontWeight: 600, color: 'var(--dsw-alias-label-tertiary,#999)' }}>缓存命中</div>
        <div style={{ fontWeight: 600, color: 'var(--dsw-alias-label-tertiary,#999)' }}>缓存创建</div>
        <div></div>
        {rows.map((r, i) => (
          <RowFragment key={i} row={r} onChange={(f, v) => updateRow(i, f, v)} onRemove={() => removeRow(i)} />
        ))}
      </div>

      <div style={{ ...S.sectionTitle, marginTop: 12 }}>每日预算上限 (元,0=不限)</div>
      <input type="text" inputMode="numeric" value={budget} onChange={(e) => setBudget(e.target.value)} style={S.input} />

      <div style={{ ...S.sectionTitle, marginTop: 12 }}>数据清理 (按条件筛选)</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginBottom: 8 }}>
        <select value={cModel} onChange={(e) => setCModel(e.target.value)} style={S.select}>
          <option value="">模型: 全部</option>
          {cleanupOpts.models.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <select value={cProvider} onChange={(e) => setCProvider(e.target.value)} style={S.select}>
          <option value="">Provider: 全部</option>
          {cleanupOpts.providers.map((p, i) => <option key={i} value={p === null ? '__null__' : p}>{lbl(p, '(无 provider)')}</option>)}
        </select>
        <select value={cSession} onChange={(e) => setCSession(e.target.value)} style={S.select}>
          <option value="">会话: 全部</option>
          {cleanupOpts.sessions.map((s, i) => <option key={i} value={s === null ? '__null__' : s}>{lbl(s, '(无会话)')}</option>)}
        </select>
        <select value={cProject} onChange={(e) => setCProject(e.target.value)} style={S.select}>
          <option value="">项目: 全部</option>
          {cleanupOpts.projects.map((p, i) => <option key={i} value={p === null ? '__null__' : p}>{lbl(p, '(无项目)')}</option>)}
        </select>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
        <span style={{ fontSize: 12 }}>且早于</span>
        <input type="text" inputMode="numeric" value={cDays} onChange={(e) => setCDays(e.target.value)} placeholder="天数" style={{ ...S.input, width: 60 }} />
        <span style={{ fontSize: 12 }}>天前的记录(留空=不限时间)</span>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button onClick={() => doCleanup(false)} disabled={cleaning} style={S.presetBtn}>{cleaning ? '清理中…' : '🗑 按条件清理'}</button>
        <button onClick={() => { if (window.confirm('确定清空全部调用记录?此操作不可恢复。')) doCleanup(true) }} disabled={cleaning} style={{ ...S.presetBtn, color: '#e5484d', borderColor: '#e5484d' }}>清空全部</button>
      </div>

      <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
        <button onClick={save} disabled={saving} style={S.saveBtn}>{saving ? '保存中…' : '💾 保存'}</button>
        {msg && <span style={{ fontSize: 12, color: msg.startsWith('✅') || msg.startsWith('已') ? '#10b981' : '#e5484d' }}>{msg}</span>}
      </div>
      {cfg?.dbPath && <div style={{ ...S.hint, marginTop: 8 }}>账本路径: {cfg.dbPath}</div>}
    </div>
  )
}

/** One price row: model input + 4 number inputs + remove button. */
function RowFragment({ row, onChange, onRemove }: { row: PriceRow; onChange: (f: keyof PriceRow, v: string) => void; onRemove: () => void }) {
  const cell = { padding: '3px 4px', fontSize: '11px', borderRadius: '4px', border: '1px solid var(--dsw-alias-border,#ddd)', background: 'var(--dsw-alias-bg,#fff)', color: 'var(--dsw-alias-label-primary,#111)', boxSizing: 'border-box' as const, width: '100%' as const }
  return (
    <>
      <input type="text" value={row.model} onChange={(e) => onChange('model', e.target.value)} placeholder="模型名" style={cell} />
      <input type="text" inputMode="decimal" value={row.input} onChange={(e) => onChange('input', e.target.value)} style={cell} />
      <input type="text" inputMode="decimal" value={row.output} onChange={(e) => onChange('output', e.target.value)} style={cell} />
      <input type="text" inputMode="decimal" value={row.cacheRead} onChange={(e) => onChange('cacheRead', e.target.value)} style={cell} />
      <input type="text" inputMode="decimal" value={row.cacheWrite} onChange={(e) => onChange('cacheWrite', e.target.value)} style={cell} />
      <button onClick={onRemove} style={{ padding: 0, border: 'none', background: 'transparent', color: '#e5484d', cursor: 'pointer', fontSize: '15px' }}>×</button>
    </>
  )
}

function Bar({ pct: p, color }: { pct: number; color?: string }) {
  return (
    <div style={S.barTrack}>
      <div style={{ ...S.barFill, width: `${Math.min(100, p * 100)}%`, background: color ?? S.barFill.background }} />
    </div>
  )
}

function Table({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <div style={S.tableWrap}>
      <div style={S.tableHead}>
        {head.map((h, i) => <div key={i} style={{ ...S.th, ...((i === 0) ? { textAlign: 'left' as const } : { textAlign: 'right' as const }) }}>{h}</div>)}
      </div>
      {rows.map((r, ri) => (
        <div key={ri} style={S.tableRow}>
          {r.map((c, ci) => <div key={ci} style={{ ...S.td, ...((ci === 0) ? { textAlign: 'left' as const } : { textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const }) }}>{c}</div>)}
        </div>
      ))}
    </div>
  )
}

const S = {
  wrap: { boxSizing: 'border-box' as const, height: '100%', overflow: 'auto' as const, padding: '16px', color: 'var(--dsw-alias-label-primary,#111)', background: 'var(--dsw-alias-bg,#fff)' },
  header: { display: 'flex' as const, alignItems: 'center' as const, justifyContent: 'space-between' as const, marginBottom: '12px', gap: '6px', flexWrap: 'nowrap' as const, overflowX: 'auto' as const },
  title: { fontSize: '15px', fontWeight: 700, flexShrink: 0 as const },
  controls: { display: 'flex' as const, gap: '3px', alignItems: 'center' as const, flexWrap: 'nowrap' as const, overflowX: 'auto' as const },
  tab: { padding: '3px 7px', fontSize: '11px', border: '1px solid var(--dsw-alias-border,#ddd)', background: 'transparent', color: 'var(--dsw-alias-label-secondary,#666)', borderRadius: '4px', cursor: 'pointer' as const, flexShrink: 0 as const, whiteSpace: 'nowrap' as const },
  tabActive: { padding: '3px 7px', fontSize: '11px', border: '1px solid var(--dsw-alias-accent,#0066cc)', background: 'var(--dsw-alias-accent,#0066cc)', color: '#fff', borderRadius: '4px', cursor: 'pointer' as const, fontWeight: 600, flexShrink: 0 as const, whiteSpace: 'nowrap' as const },
  select: { fontSize: '12px', padding: '3px 6px', background: 'var(--dsw-alias-bg-secondary,#f5f5f5)', color: 'var(--dsw-alias-label-primary)', border: '1px solid var(--dsw-alias-border,#ddd)', borderRadius: '4px' },
  kpiGrid: { display: 'grid' as const, gridTemplateColumns: 'repeat(auto-fill,minmax(120px,1fr))', gap: '8px', marginBottom: '14px' },
  kpi: { padding: '10px', background: 'var(--dsw-alias-bg-secondary,#f5f5f5)', borderRadius: '8px' },
  kpiAccent: { background: 'linear-gradient(135deg,var(--dsw-alias-accent,#0066cc),#0099ff)', color: '#fff' },
  kpiLabel: { fontSize: '11px', opacity: 0.8 },
  kpiVal: { fontSize: '18px', fontWeight: 700, fontVariantNumeric: 'tabular-nums' as const, marginTop: '2px' },
  kpiSub: { fontSize: '10px', opacity: 0.7 },
  budget: { padding: '10px', marginBottom: '12px', background: 'var(--dsw-alias-bg-secondary,#f5f5f5)', borderRadius: '8px', fontSize: '12px' },
  budgetOver: { padding: '10px', marginBottom: '12px', background: 'rgba(229,72,77,0.12)', borderRadius: '8px', fontSize: '12px', color: '#e5484d' },
  barTrack: { height: '6px', background: 'var(--dsw-alias-bg-tertiary,#e5e5e5)', borderRadius: '3px', marginTop: '6px', overflow: 'hidden' as const },
  barFill: { height: '100%', background: 'var(--dsw-alias-accent,#0066cc)', borderRadius: '3px', transition: 'width .3s' },
  sectionTitle: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary,#999)', margin: '8px 0 6px' },
  empty: { fontSize: '13px', color: 'var(--dsw-alias-label-tertiary,#999)', padding: '20px 0', textAlign: 'center' as const },
  row: { marginBottom: '10px', padding: '8px 10px', background: 'var(--dsw-alias-bg-secondary,#f5f5f5)', borderRadius: '6px' },
  rowHead: { display: 'flex' as const, justifyContent: 'space-between' as const, alignItems: 'baseline' as const },
  rowName: { fontSize: '13px', fontWeight: 600 },
  rowCost: { fontSize: '13px', fontWeight: 700, fontVariantNumeric: 'tabular-nums' as const },
  rowMeta: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary,#999)', marginTop: '3px', fontVariantNumeric: 'tabular-nums' as const },
  hint: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary,#999)', marginTop: '12px', lineHeight: 1.5, padding: '8px 10px', background: 'var(--dsw-alias-bg-secondary,#f5f5f5)', borderRadius: '6px' },
  err: { color: '#e5484d', fontSize: '12px', padding: '8px 0' },
  tableWrap: { fontSize: '12px', borderRadius: '6px', overflow: 'hidden' as const },
  tableHead: { display: 'grid' as const, gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr 1fr', background: 'var(--dsw-alias-bg-tertiary,#ebebeb)', padding: '6px 8px', gap: '4px' },
  tableRow: { display: 'grid' as const, gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr 1fr', padding: '5px 8px', borderBottom: '1px solid var(--dsw-alias-border,#eee)', gap: '4px' },
  th: { fontSize: '11px', fontWeight: 600, color: 'var(--dsw-alias-label-secondary,#666)' },
  td: { fontSize: '12px', overflow: 'hidden' as const, textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const },
  logWrap: { fontSize: '11px', fontFamily: 'ui-monospace,monospace' },
  logRow: { display: 'grid' as const, gridTemplateColumns: '64px 1fr 70px 1fr 60px', gap: '6px', padding: '3px 0', borderBottom: '1px solid var(--dsw-alias-border,#f0f0f0)' },
  logTime: { color: 'var(--dsw-alias-label-tertiary,#999)' },
  logModel: { color: 'var(--dsw-alias-label-primary)', overflow: 'hidden' as const, textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const },
  logProv: { color: 'var(--dsw-alias-label-tertiary,#999)' },
  logTok: { color: 'var(--dsw-alias-label-secondary,#666)', fontVariantNumeric: 'tabular-nums' as const },
  logCost: { color: 'var(--dsw-alias-accent,#0066cc)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' as const, textAlign: 'right' as const },
  pager: { display: 'flex' as const, justifyContent: 'space-between' as const, alignItems: 'center' as const, marginTop: '10px', gap: '8px', flexWrap: 'wrap' as const },
  pageBtn: { padding: '2px 8px', fontSize: '13px', border: '1px solid var(--dsw-alias-border,#ddd)', background: 'var(--dsw-alias-bg-secondary,#f5f5f5)', color: 'var(--dsw-alias-label-primary,#111)', borderRadius: '4px', cursor: 'pointer' as const },
  textarea: { width: '100%' as const, minHeight: '140px' as const, fontFamily: 'ui-monospace,monospace' as const, fontSize: '11px' as const, padding: '8px' as const, borderRadius: '6px' as const, border: '1px solid var(--dsw-alias-border,#ddd)' as const, background: 'var(--dsw-alias-bg,#fff)' as const, color: 'var(--dsw-alias-label-primary,#111)' as const, boxSizing: 'border-box' as const, resize: 'vertical' as const },
  input: { width: '100%' as const, padding: '6px 8px' as const, fontSize: '12px' as const, borderRadius: '6px' as const, border: '1px solid var(--dsw-alias-border,#ddd)' as const, background: 'var(--dsw-alias-bg,#fff)' as const, color: 'var(--dsw-alias-label-primary,#111)' as const, boxSizing: 'border-box' as const },
  saveBtn: { padding: '6px 14px' as const, fontSize: '12px' as const, border: 'none' as const, background: 'var(--dsw-alias-accent,#0066cc)' as const, color: '#fff' as const, borderRadius: '6px' as const, cursor: 'pointer' as const },
  presetBtn: { padding: '3px 8px' as const, fontSize: '11px' as const, border: '1px solid var(--dsw-alias-accent,#0066cc)' as const, background: 'transparent' as const, color: 'var(--dsw-alias-accent,#0066cc)' as const, borderRadius: '4px' as const, cursor: 'pointer' as const },
}
