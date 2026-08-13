/**
 * Build the browser-side client bundle into lib/client.js.
 *
 * Output shape (matches the dsh-web-ui tsdown.client.ts contract):
 *   window.__ModuleLoader__.load({ id: "dsh-cost-ledger", factory: (require) => {
 *     var module = { exports: {} }; var exports = module.exports;
 *     <bundle code>
 *     return module.exports;
 *   } });
 *
 * Platform modules (react, @deepseek-ai/dsh-client-*) stay EXTERNAL: the host's
 * module loader resolves them at runtime via the `require` handed to the
 * factory. Everything else (our own code, tiny helpers) is inlined. The bundle
 * is CommonJS (platform='browser', format='cjs') so `module.exports` works.
 *
 * Run: node scripts/build-client.mjs
 */
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')

// Modules the host module loader provides at runtime. Value imports of these
// stay external (resolved via the factory's `require`); type-only imports are
// erased by esbuild and never reach the bundle.
const PLATFORM_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-tool',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-locale/client',
  '@deepseek-ai/dsh-settings',
]

const PLUGIN_ID = 'dsh-cost-ledger'

try {
  await build({
    entryPoints: [resolve(root, 'src/client/index.tsx')],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    outfile: resolve(root, 'lib/client.js'),
    external: PLATFORM_EXTERNALS,
    // Replace Node-only env refs so browser bundles don't ReferenceError.
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
      'import.meta.env.MODE': JSON.stringify('production'),
      'import.meta.env': JSON.stringify({ MODE: 'production' }),
    },
    jsx: 'automatic',
    jsxImportSource: 'react',
    loader: { '.ts': 'ts', '.tsx': 'tsx' },
    banner: {
      js:
        `window.__ModuleLoader__.load({ id: "${PLUGIN_ID}", factory: (require) => {\n` +
        `var module = { exports: {} };\nvar exports = module.exports;`,
    },
    footer: {
      js: `return module.exports;\n} });`,
    },
    logLevel: 'info',
  })
  console.log('[build-client] wrote lib/client.js')
} catch (err) {
  console.error('[build-client] failed:', err)
  process.exit(1)
}
