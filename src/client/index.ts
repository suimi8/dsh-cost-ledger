/**
 * dsh-cost-ledger — browser-side client entry (Phase 2).
 *
 * This file is the dsh.client bundle entrypoint declared in package.json
 * (`dsh.client.inject`). Phase 1 ships WITHOUT a wired panel: this stub only
 * loads the injected runtime packages so the host can discover the client
 * without a build step. Phase 2 will register a sidebar panel here.
 *
 * The exact slot/registration API (web-ui.plugin / sidebar slots) is being
 * confirmed against the dsh-web-ui reference implementation (dsh-task-board).
 */

// The host injects these via window.__ModuleLoader__; importing them keeps the
// bundle wired to the runtime contract and gives types for Phase 2 work.
import '@deepseek-ai/dsh-client-runtime'
import '@deepseek-ai/dsh-client-ui-tool'
import '@deepseek-ai/dsh-client-ui-slots'
import '@deepseek-ai/dsh-client-ui-primitives'
import '@deepseek-ai/dsh-client-locale'

export default {
  // Phase 2: register a sidebar panel rendering a cost dashboard here.
  // Expected shape (to confirm against dsh-task-board):
  //   apply(ctx) { ctx.slots.sidebar.register({ ... render: () => <Dashboard/> }) }
  apply(_ctx: unknown) {
    // no-op for Phase 1
  },
}
