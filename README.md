# dsh-cost-ledger

> Cross-session persistent cost ledger for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
> Auto-logs every LLM token-usage event to SQLite and exposes `record_cost` / `query_cost` / `set_budget` agent tools. Built-in DeepSeek pricing, overridable via plugin config. Install-and-go, no extra wiring.

## Status

**Phase 1 (host side) — complete & live-verified in DSH 0.1.0-rc.6 (last verified 2026-08-13).** 28 data-layer checks pass (`pnpm selftest`); the plugin loads and runs in a real `dsh web` profile.

The token-usage source and tool registration API are **confirmed from DSH 0.1.0-rc.6 source** and wired for real:

| Integration | API | Status |
|---|---|---|
| Token usage capture | `ctx.on('llm/stream', (options, next) => AsyncIterable<StreamChunk>)` — Cordis waterfall around every model call | ✅ wired |
| Tool registration | `ctx.tools.register(ToolDefinition)` — real `{ name, description, parameters, output:{schema,render}, execute(args, exec) }` | ✅ wired |
| Persistent store | SQLite via `better-sqlite3` (prebuilt win32 binary, no compile) | ✅ |
| Pricing | DeepSeek official (CNY/1M tok), cache-aware; config-overridable | ✅ |
| Live load in `dsh web` | installed via `dsh plugin --profile web add .`, host loads the bundle, `apply()` runs, SQLite opens | ✅ verified |
| End-to-end token capture | `dsh --profile headless "..."` → real LLM call → `llm/stream` listener fires → usage chunk harvested → SQLite row written | ✅ verified |

**Live-verified:** a one-shot `dsh --profile headless "reply with exactly: hi"` produced real rows in `ledger.db` (`{model:"glm-5-2", inputTokens, outputTokens, cacheReadTokens}`) — the full `llm/stream` → usage-chunk → SQLite pipeline works against the real host.

Module loading uses `.ts` extension specifiers (`./store.ts`) — the Cordis loader rewrites these and loads TypeScript directly, so **no build step** is needed; the plugin runs from source after install.

Two issues found & fixed during live integration:
- **`{ global: true }` on `ctx.on('llm/stream')`** — without it the listener only sees calls from its own fiber; the agent loop dispatches from a different scope. (Mirrors the host's own `invariant.js` usage.)
- **No uninjected service access** — `ctx.session`/`ctx.workspace` throw "cannot get property without inject" unless declared in `inject`. Session id now comes from the `llm/stream` event's `options.sessionId` instead.

**Phase 2 (WebUI dashboard panel) — researched, not implemented.** See [Phase 2](#phase-2-webui-panel).

---

## What it does

- **Auto-logs token usage**: subscribes to the `llm/stream` waterfall and writes `{timestamp, session, project, model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cost}` per real provider call (including retries).
- **Computes cost**: built-in DeepSeek pricing (`deepseek-chat` / `deepseek-reasoner`, CNY per 1M tokens). `inputTokens` is uncached input; billed input = `input + cacheRead + cacheWrite`, each priced at its own rate. Override or add models via config.
- **Three agent tools**:
  - `record_cost` — manually record a usage entry (backfill/test).
  - `query_cost` — total spend + per-model breakdown within a range (`today`/`week`/`month`/`all`/ISO); reports current daily-budget status.
  - `set_budget` — create/update/remove a spending budget (`daily`/`weekly`/`monthly`/`never` window, label-scoped: `daily`, `model:<name>`, `project:<name>`).

## Install (community / standard)

```powershell
dsh plugin --profile web add <path-or-package>
```

The host discovers the plugin from `package.json` (`dsh.bundle.patch`) — no absolute path, no manual wiring. The `prepare` script builds `lib/` from source, so a git checkout installs self-contained. Restart `dsh web` after install.

> **Git install note:** pnpm ≥10 blocks a git dependency's `prepare` script until allowed. If the first `add` fails, copy the exact package key pnpm printed into the profile's `pnpm-workspace.yaml` (`allowBuilds: dsh-cost-ledger: true`) and re-run — exactly as the official docs describe.

## Local development

```powershell
pnpm install
pnpm selftest              # verify the data layer (28 checks)
pnpm typecheck
pnpm build                 # build host (lib/*.js) + client (lib/client.js)

# load into a running dsh web via the patch (absolute path, this machine):
dsh web --patch ./cordis.patch.yml
```

## Pricing — built-in official rates

Built-in model pricing (元/百万 tokens, from each platform's official pricing page):
- `deepseek-v4-flash` — input 0.10 / output 3.0 / cacheRead 9.0 (peak tier)
- `deepseek-v4-pro` — input 0.30 / output 9.0 / cacheRead 27.0 (peak tier)
- `deepseek-chat` (V3) / `deepseek-reasoner` (R1) — legacy aliases
- `glm-5-2` — default 0 (override in the dashboard ⚙️设置 tab or config; fill from Zhipu's pricing)

Unknown models record tokens only (cost = 0) until you set a price. Override anytime via the **⚙️设置 tab** in the dashboard or the WebUI settings card — changes apply to new calls immediately.

## Config

Edited in the dashboard **⚙️设置** tab (runtime, not persisted across restart) or under the WebUI plugin config card (durable) / `cordis.patch.yml`:

```yaml
config:
  dbPath: 'dsh-cost-ledger/ledger.db'      # relative to DSH cwd
  defaultDailyBudget: 0                     # CNY; 0 = no limit
  pricing:
    deepseek-chat:                          # override or add any model
      input: 2
      output: 8
      cacheRead: 0.5
      cacheWrite: 8
```

## Architecture

```
src/
  pricing.ts   built-in DeepSeek price table + computeCost()
  store.ts     SQLite ledger: insert + summaryByModel + spentSince + budgets
  tools.ts     three ToolDefs (pure handlers over store + config)
  config.ts    Schema (schemastery) config
  index.ts     apply(ctx): llm/stream listener + registerTools + cleanup
  client/      Phase 2 WebUI entry (stub)
cordis.patch.yml   local-dev profile patch (absolute path)
scripts/selftest.ts   standalone data-layer verification
```

### Token capture (confirmed API)

`llm/stream` is a Cordis **waterfall** wrapping every streaming model call (retries included). The listener transparently forwards the underlying stream while harvesting the `usage` chunk:

```ts
ctx.on('llm/stream', (options, next) => (async function* () {
  let usage: TokenUsage | undefined
  for await (const chunk of next()) {
    if (chunk.type === 'usage') usage = chunk.usage
    yield chunk
  }
  if (usage) record(options, usage)   // persist one row
})())
```

Key billing facts (from official `TokenUsage`):
- `inputTokens` = uncached input only. Billed input = `input + cacheRead + cacheWrite`.
- `reasoningTokens` is already included in `outputTokens` — never double-count.
- `usage` is not guaranteed (early abort/error) — absence is logged at debug.

The `TokenUsage` / `StreamChunk` / `GenerateOptions` types live in `@deepseek-ai/dsh-llm` (an unpublished host-injected package). This plugin declares minimal local types to typecheck standalone; swap for a real `import type` once the host package is resolvable.

## Phase 2 (WebUI panel)

Researched against the `dsh-web-ui` reference. Key finding: **DSH exposes no general-purpose sidebar-panel slot** for external plugins. `sidebar.workspaces` / `sidebar.settings` are single-occupant and taken by the shell. Options:

- **DOM-level bypass** (the `dsh-task-board` / `dsh-ssh` approach): `MutationObserver` + `createRoot` into `[data-pane="sidebar"]` / `[data-pane="conversation"]`. Most flexible.
- **Settings card** via `web-ui.plugin.item` (lightest — a summary card under Settings → Plugins).
- **No chart-library precedent** in the ecosystem. Recommended: inline SVG, or vendor `recharts` (strict CSP, no CDN).

## Compatibility

- **DSH version:** verified against `0.1.0-rc.6` (the API surface — `ctx.on('llm/stream')`, `ctx.tools.register`, `ctx.inject`, `agentDefaultModel` — is confirmed from DSH 0.1.0-rc.6 source).
- **Last verified:** 2026-08-13.
- **Profiles:** loads under both `dsh web` (full UI + HTTP API + dashboard) and `dsh --profile headless` (token capture + tools only; HTTP API and dashboard are web-profile-only and silently skipped).
- **OS:** the SQLite backend ships a prebuilt win32 binary via `better-sqlite3`; other platforms build from source at install time (requires a C++ toolchain). Verified on Windows 11 / Node 22.
- **Pre-release caveat:** DSH is in developer preview with expected compatibility-breaking changes. The token-usage source and tool registration API are confirmed against rc.6; a future mainline may rename them, which would require a plugin update.

## Install

```powershell
dsh plugin --profile web add <path-or-package>
```

The host discovers the plugin from `package.json` (`dsh.bundle.patch`) — no absolute path, no manual wiring. The `prepare` script builds `lib/` from source, so a git checkout installs self-contained. Restart `dsh web` after install.

> **Git install note:** pnpm ≥10 blocks a git dependency's `prepare` script until allowed. If the first `add` fails, copy the exact package key pnpm printed into the profile's `pnpm-workspace.yaml` (`allowBuilds: dsh-cost-ledger: true`) and re-run — exactly as the official docs describe.

## Uninstall

```powershell
# Remove the bundle from the profile, then restart dsh web
dsh plugin --profile web remove dsh-cost-ledger
```

This removes the bundle from the profile's `dsh.profile.bundles` list and unlinks the package. The ledger database (`dsh-cost-ledger/ledger.db`) and any config overrides in `cordis.patch.yml` are **not** removed automatically — delete them manually if you want a clean sweep:

```powershell
Remove-Item -Recurse -Force dsh-cost-ledger   # the data dir created under the DSH cwd
```

To disable temporarily without removing: comment out `dsh-cost-ledger` in the profile's `cordis.yml` `bundles` list and restart.

## Quick start

```powershell
# 1. Install into your web profile (see Install above)
dsh plugin --profile web add .

# 2. Restart dsh web, then just use the agent normally
dsh web
```

Every model call is now auto-logged. After a few prompts, ask the agent to query spend:

```
> 查一下今天花了多少钱（query_cost today）
```

Or open the dashboard panel in the Web UI (the cost-ledger tab) to see a live summary, per-model breakdown, and the budget/budget settings — no extra wiring.

## Permissions & data

- **Files written:** one SQLite database at `dsh-cost-ledger/ledger.db` (path configurable via `dbPath`, relative to the DSH working directory) plus its WAL/SHM sidecar files. Nothing else touches the filesystem.
- **Network:** none. The plugin makes no outbound network calls. (The `parse-prices` endpoint calls the **host's** own `ctx.llm.stream()` — it reuses the model call path you already configured, not a new connection.)
- **Credentials:** none read, stored, or transmitted. The plugin never touches your API keys; it only reads token counts and model names that the host already emits on the `llm/stream` event.
- **Data logged per model call:** `{timestamp, sessionId, project, model, provider, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cost}`. No prompt content or completions are ever stored — only aggregate token counts and metadata.
- **HTTP API:** when running under `dsh web`, the plugin registers read-only-ish JSON endpoints under `/api/cost-ledger/*`. They bind to the host's web server and are reachable from the same origin as the Web UI. The `cleanup` and `parse-prices` endpoints are write/POST endpoints intended for the dashboard UI.

## Troubleshooting

- **`Cannot find module './store.ts'` / load error after a git pull:** the Cordis loader resolves `.ts` specifiers directly, but a stale `lib/` can interfere. Run `pnpm build` (or `pnpm install` to trigger `prepare`) and restart `dsh web`.
- **`better-sqlite3` install fails on macOS/Linux:** the prebuilt binary is win32-only; other platforms compile from source. Install a C++ toolchain (`build-essential` / Xcode CLT) and re-run `pnpm install`.
- **No cost rows appear:** confirm the model call actually emitted a `usage` chunk (early aborts/errors may not). Token capture is best-effort — absent usage is logged at debug level. Also confirm `dbPath` is writable.
- **`parse-prices` returns 503 / "default model not configured":** the `agentDefaultModel` service hadn't resolved yet, or no default model is set in Agent settings. Set a default model and retry.
- **pnpm blocks the `prepare` script on git install:** add `allowBuilds: dsh-cost-ledger: true` to the profile's `pnpm-workspace.yaml` and re-run `dsh plugin add`.
- **Logs:** plugin diagnostics go to the host log (`dsh web` console / `dsh-run.log`); the SQLite ledger itself is the system of record for cost data.
- **Rollback:** `dsh plugin --profile web remove dsh-cost-ledger` + restart; optionally delete the `dsh-cost-ledger/` data dir (see Uninstall).

## Development

```powershell
pnpm install
pnpm selftest              # verify the data layer (28 checks)
pnpm typecheck
pnpm build                 # build host (lib/*.js) + client (lib/client.js)

# load into a running dsh web via the patch (absolute path, this machine):
dsh web --patch ./cordis.patch.yml
```

`react` / `react-dom` and the `@deepseek-ai/dsh-client-*` runtime packages are **external** to the client bundle (resolved by the host's module loader at runtime), so they are correctly declared as `devDependencies` / `peerDependencies`, not `dependencies`. The only runtime `dependency` is `better-sqlite3`.

## License & security

MIT — see [LICENSE](LICENSE).

**Security reporting:** this plugin has no network surface and stores no credentials, but if you find a vulnerability (e.g. unsafe SQL handling, path traversal via `dbPath`), please **do not open a public issue**. Report it privately via [GitHub Security Advisories](https://github.com/suimi8/dsh-cost-ledger/security/advisories/new) (Security → Report a vulnerability on the repo). All SQL uses parameterized statements (`@named` bind params) and all filesystem access is confined to the configured `dbPath`.
