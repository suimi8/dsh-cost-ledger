/**
 * Inline-SVG charts (no chart library). All theme-aware via CSS variables.
 *  - CostTrend: cumulative cost line chart over time buckets.
 *  - Donut: token distribution (input / output / cache) as a donut.
 *  - BarChart: horizontal bars for per-model / per-provider cost.
 */

interface TrendPoint {
  t: string
  cost: number
  inputTokens: number
  outputTokens: number
}

function fmt(n: number): string {
  if (n >= 1e8) return (n / 1e8).toFixed(1) + '亿'
  if (n >= 1e4) return (n / 1e4).toFixed(1) + '万'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
  return String(Math.round(n))
}
function money(n: number): string {
  if (n === 0) return '¥0'
  if (n < 0.01) return '¥' + n.toFixed(4)
  return '¥' + n.toFixed(2)
}

/** Cumulative cost line chart. */
export function CostTrend({ points }: { points: TrendPoint[] }) {
  const W = 380, H = 120, PAD = 28
  if (points.length < 2) {
    return <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary,#999)', padding: '24px 0', textAlign: 'center' }}>暂无趋势数据</div>
  }
  const max = Math.max(0.0001, ...points.map((p) => p.cost))
  const minT = new Date(points[0].t).getTime()
  const maxT = new Date(points[points.length - 1].t).getTime()
  const span = Math.max(1, maxT - minT)
  const x = (t: number) => PAD + ((t - minT) / span) * (W - PAD * 2)
  const y = (c: number) => H - PAD - (c / max) * (H - PAD * 2)
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(new Date(p.t).getTime())},${y(p.cost)}`).join(' ')
  const area = `${path} L${x(maxT)},${H - PAD} L${x(minT)},${H - PAD} Z`
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: H }}>
      <defs>
        <linearGradient id="cl-area" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--dsw-alias-accent,#0066cc)" stopOpacity="0.25" />
          <stop offset="100%" stopColor="var(--dsw-alias-accent,#0066cc)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0, 0.5, 1].map((g) => (
        <line key={g} x1={PAD} x2={W - PAD} y1={y(max * g)} y2={y(max * g)} stroke="var(--dsw-alias-border,#eee)" strokeWidth="1" />
      ))}
      <path d={area} fill="url(#cl-area)" />
      <path d={path} fill="none" stroke="var(--dsw-alias-accent,#0066cc)" strokeWidth="2" strokeLinejoin="round" />
      <text x={PAD} y={H - 6} fontSize="9" fill="var(--dsw-alias-label-tertiary,#999)">{new Date(points[0].t).toLocaleDateString()}</text>
      <text x={W - PAD} y={H - 6} fontSize="9" fill="var(--dsw-alias-label-tertiary,#999)" textAnchor="end">{money(points[points.length - 1].cost)}</text>
    </svg>
  )
}

/** Token distribution donut. */
export function TokenDonut({ input, output, cache }: { input: number; output: number; cache: number }) {
  const total = input + output + cache
  if (total === 0) {
    return <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary,#999)', padding: '24px 0', textAlign: 'center' }}>暂无 token 数据</div>
  }
  const R = 54, r = 32, CX = 70, CY = 70
  const segs = [
    { label: '输入', val: input, color: '#3b82f6' },
    { label: '输出', val: output, color: '#10b981' },
    { label: '缓存', val: cache, color: '#f59e0b' },
  ].filter((s) => s.val > 0)
  let acc = 0
  const arcs = segs.map((s) => {
    const start = acc / total
    acc += s.val
    const end = acc / total
    return { ...s, start, end }
  })
  const arc = (a0: number, a1: number) => {
    const p = (a: number) => [CX + R * Math.cos(a - Math.PI / 2), CY + R * Math.sin(a - Math.PI / 2)]
    const pi = (a: number) => [CX + r * Math.cos(a - Math.PI / 2), CY + r * Math.sin(a - Math.PI / 2)]
    const [x1, y1] = p(a0 * 2 * Math.PI)
    const [x2, y2] = p(a1 * 2 * Math.PI)
    const [x3, y3] = pi(a1 * 2 * Math.PI)
    const [x4, y4] = pi(a0 * 2 * Math.PI)
    const large = a1 - a0 > 0.5 ? 1 : 0
    return `M${x1},${y1} A${R},${R} 0 ${large} 1 ${x2},${y2} L${x3},${y3} A${r},${r} 0 ${large} 0 ${x4},${y4} Z`
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
      <svg viewBox="0 0 140 140" style={{ width: 140, height: 140, flexShrink: 0 }}>
        {arcs.map((a, i) => <path key={i} d={arc(a.start, a.end)} fill={a.color} />)}
        <text x={CX} y={CY - 4} fontSize="9" fill="var(--dsw-alias-label-tertiary,#999)" textAnchor="middle">总计</text>
        <text x={CX} y={CY + 10} fontSize="13" fontWeight="700" fill="var(--dsw-alias-label-primary,#111)" textAnchor="middle">{fmt(total)}</text>
      </svg>
      <div style={{ fontSize: 12 }}>
        {segs.map((s) => (
          <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: s.color, display: 'inline-block' }} />
            <span style={{ color: 'var(--dsw-alias-label-secondary,#666)' }}>{s.label}</span>
            <span style={{ marginLeft: 'auto', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{fmt(s.val)}</span>
            <span style={{ color: 'var(--dsw-alias-label-tertiary,#999)', width: 36, textAlign: 'right' }}>{((s.val / total) * 100).toFixed(0)}%</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Horizontal bar chart for cost by key. */
export function BarChart({ data }: { data: { label: string; value: number; sub?: string }[] }) {
  if (data.length === 0) return <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary,#999)', padding: '16px 0', textAlign: 'center' }}>暂无数据</div>
  const max = Math.max(0.0001, ...data.map((d) => d.value))
  const colors = ['#0066cc', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316']
  return (
    <div>
      {data.map((d, i) => (
        <div key={d.label} style={{ marginBottom: '10px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: '3px' }}>
            <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '60%' }}>{d.label}</span>
            <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{money(d.value)}</span>
          </div>
          <div style={{ height: 8, background: 'var(--dsw-alias-bg-tertiary,#e5e5e5)', borderRadius: 4, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${(d.value / max) * 100}%`, background: colors[i % colors.length], borderRadius: 4, transition: 'width .3s' }} />
          </div>
          {d.sub && <div style={{ fontSize: 10, color: 'var(--dsw-alias-label-tertiary,#999)', marginTop: 2 }}>{d.sub}</div>}
        </div>
      ))}
    </div>
  )
}
