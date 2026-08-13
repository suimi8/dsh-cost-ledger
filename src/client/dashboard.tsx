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
          {tab !== 'settings' && (
            <select value={range} onChange={(e) => setRange(e.target.value as typeof range)} style={S.select}>
              {RANGES.map((r) => <option key={r} value={r}>{RANGE_LABELS[r]}</option>)}
            </select>
          )}
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

/** Settings panel: edit model pricing (JSON) + daily budget, persisted via host API. */
function SettingsPanel() {
  const [cfg, setCfg] = useState<PluginConfig | null>(null)
  const [pricingText, setPricingText] = useState('')
  const [budget, setBudget] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const c = await fetch('/api/cost-ledger/config').then((r) => r.json())
      setCfg(c)
      setPricingText(JSON.stringify(c.pricing ?? {}, null, 2))
      setBudget(String(c.defaultDailyBudget ?? 0))
    } catch (e) { setMsg(String(e)) }
  }, [])
  useEffect(() => { load() }, [load])

  const save = async () => {
    setSaving(true); setMsg(null)
    try {
      const pricing = JSON.parse(pricingText)
      const patch: Partial<PluginConfig> = { pricing }
      const b = Number(budget)
      if (Number.isFinite(b)) patch.defaultDailyBudget = b
      const res = await fetch('/api/cost-ledger/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setMsg('✅ 已保存,新对话的 token 将按新价格计算')
      load()
    } catch (e) {
      setMsg('❌ ' + String(e))
    } finally { setSaving(false) }
  }

  const [cleanupDays, setCleanupDays] = useState('30')
  const [autoCleanup, setAutoCleanup] = useState(false)

  // Built-in official pricing presets (元/百万 token), categorized.
  const PRESETS: Record<string, Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>> = {
    'DeepSeek 官方 (V4)': {
      'deepseek-v4-flash': { input: 0.1, output: 3, cacheRead: 9, cacheWrite: 3 },
      'deepseek-v4-pro': { input: 0.3, output: 9, cacheRead: 27, cacheWrite: 9 },
    },
    'DeepSeek 旧版 (V3/R1)': {
      'deepseek-chat': { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 8 },
      'deepseek-reasoner': { input: 4, output: 16, cacheRead: 1, cacheWrite: 8 },
    },
  }

  const applyPreset = (key: string) => {
    const p = PRESETS[key]
    try {
      const cur = JSON.parse(pricingText || '{}')
      setPricingText(JSON.stringify({ ...cur, ...p }, null, 2))
      setMsg(`已填入 ${key} 价格,点击保存生效`)
    } catch { setMsg('❌ 当前 JSON 格式错误,无法合并') }
  }

  const doCleanup = async () => {
    const days = Math.max(1, Number(cleanupDays) || 30)
    try {
      const r = await fetch('/api/cost-ledger/cleanup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ days }) })
      const j = await r.json()
      setMsg(`已清理 ${j.deleted} 条,剩余 ${j.remaining} 条`)
    } catch (e) { setMsg('❌ ' + String(e)) }
  }

  return (
    <div style={{ fontSize: 13 }}>
      <div style={S.sectionTitle}>模型价格 (JSON · 元/百万 token)</div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
        {Object.keys(PRESETS).map((k) => (
          <button key={k} onClick={() => applyPreset(k)} style={S.presetBtn}>{k}</button>
        ))}
      </div>
      <textarea value={pricingText} onChange={(e) => setPricingText(e.target.value)} style={S.textarea}
        placeholder={'{\n  "glm-5-2": { "input": 0.5, "output": 2, "cacheRead": 0.05, "cacheWrite": 2 }\n}'} />
      <div style={S.hint}>每个模型 4 字段:输入成本 / 输出成本 / 缓存命中 / 缓存创建。点上方按钮填入官方价,或从模型官网/上游(sub2api、newapi 等)查后手填。</div>

      <div style={{ ...S.sectionTitle, marginTop: 12 }}>每日预算上限 (元,0=不限)</div>
      <input type="text" inputMode="numeric" value={budget} onChange={(e) => setBudget(e.target.value)} style={S.input} />

      <div style={{ ...S.sectionTitle, marginTop: 12 }}>数据清理</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12 }}>删除</span>
        <input type="text" inputMode="numeric" value={cleanupDays} onChange={(e) => setCleanupDays(e.target.value)} style={{ ...S.input, width: 60 }} />
        <span style={{ fontSize: 12 }}>天前的记录</span>
        <button onClick={doCleanup} style={S.presetBtn}>立即清理</button>
        <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
          <input type="checkbox" checked={autoCleanup} onChange={(e) => setAutoCleanup(e.target.checked)} /> 启动时自动清理
        </label>
      </div>
      <div style={S.hint}>autoCleanup 勾选后,插件加载时自动删除超过 N 天的旧记录(配置: cordis.patch.yml 的 cleanupDays)。</div>

      <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
        <button onClick={save} disabled={saving} style={S.saveBtn}>{saving ? '保存中…' : '💾 保存价格'}</button>
        {msg && <span style={{ fontSize: 12, color: msg.startsWith('✅') || msg.startsWith('已') ? '#10b981' : '#e5484d' }}>{msg}</span>}
      </div>
      {cfg?.dbPath && <div style={{ ...S.hint, marginTop: 8 }}>账本路径: {cfg.dbPath}</div>}
    </div>
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
  header: { display: 'flex' as const, alignItems: 'center' as const, justifyContent: 'space-between' as const, marginBottom: '12px', gap: '8px', flexWrap: 'wrap' as const },
  title: { fontSize: '16px', fontWeight: 700 },
  controls: { display: 'flex' as const, gap: '4px', alignItems: 'center' as const, flexWrap: 'wrap' as const },
  tab: { padding: '4px 10px', fontSize: '12px', border: '1px solid var(--dsw-alias-border,#ddd)', background: 'transparent', color: 'var(--dsw-alias-label-secondary,#666)', borderRadius: '4px', cursor: 'pointer' as const },
  tabActive: { padding: '4px 10px', fontSize: '12px', border: '1px solid var(--dsw-alias-accent,#0066cc)', background: 'var(--dsw-alias-accent,#0066cc)', color: '#fff', borderRadius: '4px', cursor: 'pointer' as const, fontWeight: 600 },
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
