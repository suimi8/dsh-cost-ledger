/**
 * Mount the cost dashboard as a clean right-side drawer + floating toggle.
 *
 * A sidebar DOM injection was attempted but the shell's real structure
 * differs from the assumed selectors (no [data-pane="sidebar"]). Rather than
 * blind DOM guessing, the dashboard mounts as a fixed drawer toggled by a
 * floating button — robust and self-contained. Price editing is handled by
 * the host-side settings namespace (Settings → Plugins → cost-ledger).
 */
import { createRoot, type Root } from 'react-dom/client'
import { Dashboard } from './dashboard'

const ACTIVE_ATTR = 'data-dsh-cost-ledger-open'
const TOGGLE_ID = 'dsh-cost-ledger-toggle'
const DRAWER_ID = 'dsh-cost-ledger-drawer'

const ICON = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 2h10v12H3z"/><path d="M3 6h10M6.5 6v8"/></svg>`

let open = false

export function mountCostLedger(): () => void {
  // --- Toggle button (floating, bottom-right) ---
  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.id = TOGGLE_ID
  toggle.title = '成本账本'
  toggle.setAttribute('aria-label', '成本账本')
  Object.assign(toggle.style, {
    position: 'fixed', bottom: '16px', right: '16px', zIndex: '99999',
    display: 'flex', alignItems: 'center', gap: '6px',
    padding: '8px 12px', borderRadius: '20px',
    border: '1px solid var(--dsw-alias-border,#ddd)',
    background: 'var(--dsw-alias-accent,#0066cc)', color: '#fff',
    fontSize: '13px', fontWeight: 600, cursor: 'pointer',
    boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
  } as const)
  toggle.innerHTML = `<span style="display:flex">${ICON}</span><span>成本账本</span>`
  toggle.addEventListener('click', () => { open = !open; sync() })

  // --- Drawer (right side, scrollable, closable) ---
  const drawer = document.createElement('div')
  drawer.id = DRAWER_ID
  Object.assign(drawer.style, {
    position: 'fixed', top: '0', right: '0', bottom: '0',
    width: '440px', maxWidth: '92vw', zIndex: '99998',
    background: 'var(--dsw-alias-bg,#fff)',
    boxShadow: '-6px 0 24px rgba(0,0,0,0.25)',
    borderLeft: '1px solid var(--dsw-alias-border,#ddd)',
    transform: 'translateX(100%)', transition: 'transform .25s ease',
    display: 'flex', flexDirection: 'column',
  } as const)

  const close = document.createElement('button')
  close.type = 'button'
  close.textContent = '×'
  Object.assign(close.style, {
    position: 'absolute', top: '8px', right: '8px', zIndex: '99999',
    width: '30px', height: '30px', borderRadius: '6px',
    border: '1px solid var(--dsw-alias-border,#ddd)',
    background: 'var(--dsw-alias-bg-secondary,#f0f0f0)',
    color: 'var(--dsw-alias-label-primary,#333)',
    fontSize: '20px', lineHeight: '1', cursor: 'pointer',
  } as const)
  close.addEventListener('click', () => { open = false; sync() })

  const inner = document.createElement('div')
  Object.assign(inner.style, { flex: '1', overflow: 'auto', paddingTop: '44px' } as const)

  drawer.appendChild(close)
  drawer.appendChild(inner)
  document.body.appendChild(toggle)
  document.body.appendChild(drawer)

  let root: Root | undefined
  function ensureRoot(): void {
    if (root) return
    root = createRoot(inner)
    root.render(<Dashboard />)
  }

  function sync(): void {
    if (open) {
      ensureRoot()
      drawer.style.transform = 'translateX(0)'
      toggle.style.display = 'none'        // hide floating button while open
      document.documentElement.setAttribute(ACTIVE_ATTR, '')
    } else {
      drawer.style.transform = 'translateX(100%)'
      toggle.style.display = 'flex'         // show again when closed
      document.documentElement.removeAttribute(ACTIVE_ATTR)
    }
  }

  // Click outside (on the backdrop-like body) to close — optional, lightweight.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && open) { open = false; sync() }
  })

  return () => {
    root?.unmount()
    root = undefined
    toggle.remove()
    drawer.remove()
    document.documentElement.removeAttribute(ACTIVE_ATTR)
  }
}
