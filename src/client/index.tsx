/**
 * dsh-cost-ledger browser-side client entry.
 *
 * Built by scripts/build-client.mjs into lib/client.js, wrapped in
 * window.__ModuleLoader__.load({ id, factory }).
 *
 * Two surfaces:
 *  - Dashboard (right-side drawer via DOM mount) — toggled by floating button.
 *  - Settings card (settings.plugin.item slot) — price/budget editing.
 */

import { mountCostLedger } from './mount'
import { CostLedgerSettingsCard, CostLedgerCardController, type CostLedgerSettings } from './settings-card'
import type { SettingsScope, SnapshotStore } from './settings-form'

export const inject = ['slots', 'locale', 'settingsScope']

interface ClientContext {
  effect?: (fn: () => () => void, label?: string) => unknown
  locale?: { register: (ns: string, dict: Record<string, Record<string, string>>) => unknown }
  settingsScope?: { bind<T>(opts: { namespace: string }): SettingsScope<T> }
  slots?: {
    inject: (slot: string, factory: () => unknown) => () => void
    register: (desc: Record<string, unknown>, Component: React.FC<any>) => () => void
  }
}

export function apply(ctx: ClientContext): void {
  ctx.locale?.register('cost-ledger', { 'zh-CN': {}, 'en-US': {} })

  // --- Dashboard drawer ---
  const disposeDash = mountCostLedger()
  ctx.effect?.(() => disposeDash, 'cost-ledger: dashboard')

  // --- Settings card (price editing) ---
  if (ctx.settingsScope && ctx.slots) {
    const scope = ctx.settingsScope.bind<CostLedgerSettings>({ namespace: 'cost-ledger' })
    const card = new CostLedgerCardController(scope)
    const dispose = ctx.slots.inject('settings.plugin.item', () =>
      ctx.slots!.register(
        { name: 'settings.plugin.item', id: 'cost-ledger', order: 130, locale: 'cost-ledger', inject: () => card.inject() },
        CostLedgerSettingsCard,
      ),
    )
    ctx.effect?.(() => dispose, 'cost-ledger: settings card')
  }
}
