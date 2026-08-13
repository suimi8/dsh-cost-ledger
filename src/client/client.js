/**
 * dsh-cost-ledger — browser-side client bundle.
 *
 * The host (dsh-client-modules) serves this file verbatim as a classic browser
 * script at /plugins/dsh-cost-ledger/client.js and expects it to self-register
 * its factory via window.__ModuleLoader__.load({ id, factory }). Executing the
 * bundle ONLY registers the factory; the factory body runs later at
 * materialization (factory(require) → exports, memoized). There is NO build
 * step on the client half — this must be plain browser-runnable JS, not TS.
 *
 * Phase 1 ships a no-op panel: the factory wires nothing yet. The dsh.client
 * `inject` list tells the host which sibling bundles must arrive before this
 * one; they are resolvable through the `require` handed to the factory
 * (e.g. require("@deepseek-ai/dsh-client-runtime/client")) once Phase 2 adds a
 * sidebar dashboard. Keep this self-registering shape when extending.
 */
window.__ModuleLoader__.load({
  id: "dsh-cost-ledger",
  factory: (_require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    // Phase 2: require the injected runtime/slots packages and register a
    // sidebar panel here, e.g.
    //   const runtime = require("@deepseek-ai/dsh-client-runtime/client");
    //   ctx.slots.sidebar.register({ ... render: () => <Dashboard/> });

    /** No-op plugin apply; Phase 2 will wire the cost dashboard. */
    function apply(_ctx) {
      // no-op for Phase 1
    }

    exports.apply = apply;
    return module.exports;
  }
});
