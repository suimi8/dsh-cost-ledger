/**
 * Cost-ledger settings card: edit model pricing (JSON), daily budget, db path.
 * Registers into the `settings.plugin.item` slot, bound to the `cost-ledger`
 * settings namespace (registered host-side via installSettingsSection).
 */
import { useState } from 'react'
import { CardForm, numberField, jsonField, type CardActions, type CardShell, type FieldState, type SettingsScope, type SnapshotStore } from './settings-form'

export interface CostLedgerSettings {
  dbPath?: string
  defaultDailyBudget?: number
  pricing?: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>
}

export interface CardState extends CardShell {
  pricing: FieldState
  defaultDailyBudget: FieldState
}

export interface CardFace extends CardActions {
  hooks: { costLedgerCard: SnapshotStore<CardState> }
}

export class CostLedgerCardController {
  private readonly form: CardForm<CostLedgerSettings>
  private readonly store: SnapshotStore<CardState>
  constructor(scope: SettingsScope<CostLedgerSettings>) {
    this.form = new CardForm(scope, [
      jsonField('pricing'),
      numberField('defaultDailyBudget'),
    ])
    this.store = this.form.bind(() => this.projection())
  }
  private projection(): CardState {
    return { ...this.form.shell(), pricing: this.form.field('pricing'), defaultDailyBudget: this.form.field('defaultDailyBudget') }
  }
  inject(): CardFace {
    return { hooks: { costLedgerCard: this.store }, ...this.form.actions() }
  }
}

/** The React card component. Props are injected by the slot runtime. */
export interface CardProps {
  useCostLedgerCard: (sel: (s: CardState) => CardState) => CardState
  edit: (field: string, text: string) => void
  resetField: (field: string) => void
  save: () => void
  discard: () => void
  t?: (key: string) => string
}

export function CostLedgerSettingsCard(props: CardProps) {
  const state = props.useCostLedgerCard((s) => s)
  const [open, setOpen] = useState(true)
  if (!state.available) return null
  const blocked = !state.dirty || state.invalid || state.saving
  const t = props.t ?? ((k: string) => k)
  return (
    <li style={{ listStyle: 'none', margin: '8px 0', border: '1px solid var(--dsw-alias-border,#ddd)', borderRadius: '8px', overflow: 'hidden' }}>
      <button type="button" onClick={() => setOpen(!open)} style={{ width: '100%', padding: '10px 12px', background: 'var(--dsw-alias-bg-secondary,#f5f5f5)', border: 'none', cursor: 'pointer', textAlign: 'left', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>
          <span style={{ fontWeight: 700, fontSize: '13px' }}>💰 成本账本</span>
          <span style={{ display: 'block', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary,#999)' }}>模型价格、预算与存储路径</span>
        </span>
        {state.dirty && <span style={{ fontSize: '10px', color: '#f59e0b' }}>未保存</span>}
      </button>
      {open && (
        <div style={{ padding: '12px' }}>
          {!state.writable && <p style={{ fontSize: '12px', color: '#e5484d' }}>当前设置只读</p>}

          <div style={{ marginBottom: '12px' }}>
            <label style={{ fontSize: '12px', fontWeight: 600, display: 'block', marginBottom: '4px' }}>模型价格 (JSON)</label>
            <textarea
              value={state.pricing.text}
              onChange={(e) => props.edit('pricing', e.target.value)}
              disabled={!state.writable}
              placeholder={'{\n  "glm-5-2": { "input": 0.5, "output": 2, "cacheRead": 0.05, "cacheWrite": 2 },\n  "deepseek-chat": { "input": 2, "output": 8, "cacheRead": 0.5, "cacheWrite": 8 }\n}'}
              style={{ width: '100%', minHeight: '120px', fontFamily: 'ui-monospace,monospace', fontSize: '11px', padding: '8px', borderRadius: '6px', border: state.pricing.invalid ? '1px solid #e5484d' : '1px solid var(--dsw-alias-border,#ddd)', background: 'var(--dsw-alias-bg,#fff)', color: 'var(--dsw-alias-label-primary,#111)', boxSizing: 'border-box' }}
            />
            {state.pricing.invalid && <p style={{ fontSize: '11px', color: '#e5484d', marginTop: '2px' }}>JSON 格式错误：需要对象，如 {"{model: {input, output, cacheRead, cacheWrite}}"}</p>}
            <p style={{ fontSize: '11px', color: 'var(--dsw-alias-label-tertiary,#999)', marginTop: '2px' }}>每个模型 4 个字段：input/output/cacheRead/cacheWrite，单位 元/百万 token</p>
            {state.pricing.overridden && <button type="button" onClick={() => props.resetField('pricing')} style={{ fontSize: '10px', marginTop: '2px', border: 'none', background: 'transparent', color: 'var(--dsw-alias-accent,#0066cc)', cursor: 'pointer' }}>恢复默认</button>}
          </div>

          <div style={{ marginBottom: '12px' }}>
            <label style={{ fontSize: '12px', fontWeight: 600, display: 'block', marginBottom: '4px' }}>每日预算上限 (元，0=不限)</label>
            <input
              type="text"
              inputMode="numeric"
              value={state.defaultDailyBudget.text}
              onChange={(e) => props.edit('defaultDailyBudget', e.target.value)}
              disabled={!state.writable}
              placeholder="0"
              style={{ width: '100%', padding: '6px 8px', fontSize: '12px', borderRadius: '6px', border: state.defaultDailyBudget.invalid ? '1px solid #e5484d' : '1px solid var(--dsw-alias-border,#ddd)', background: 'var(--dsw-alias-bg,#fff)', color: 'var(--dsw-alias-label-primary,#111)', boxSizing: 'border-box' }}
            />
          </div>

          {state.failed && <p style={{ fontSize: '11px', color: '#e5484d', marginBottom: '8px' }}>保存失败，部署未接受这些值</p>}
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
            <button type="button" onClick={props.discard} disabled={!state.dirty || state.saving} style={{ padding: '6px 14px', fontSize: '12px', border: '1px solid var(--dsw-alias-border,#ddd)', background: 'transparent', color: 'var(--dsw-alias-label-secondary,#666)', borderRadius: '6px', cursor: 'pointer' }}>放弃</button>
            <button type="button" onClick={props.save} disabled={blocked} style={{ padding: '6px 14px', fontSize: '12px', border: 'none', background: 'var(--dsw-alias-accent,#0066cc)', color: '#fff', borderRadius: '6px', cursor: blocked ? 'not-allowed' : 'pointer', opacity: blocked ? 0.5 : 1 }}>{state.saving ? '保存中…' : '保存'}</button>
          </div>
        </div>
      )}
    </li>
  )
}
