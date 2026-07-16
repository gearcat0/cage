import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

// electron-vite splits the build into three independent bundles: main, preload,
// and renderer (the host chrome UI). The cage itself renders untrusted `thing://`
// bytes that are NOT part of this build — they are supplied at load time.
export default defineConfig({
  main: {
    // `electron` lives in devDependencies, so it must be externalized explicitly
    // — otherwise vite bundles the npm stub and `session`/`app` come back
    // undefined at runtime. externalizeDepsPlugin handles the node builtins.
    plugins: [externalizeDepsPlugin({ include: ['electron'] })],
    build: {
      outDir: 'out/main',
      rollupOptions: {
        external: ['electron'],
        input: { index: resolve(__dirname, 'src/main/index.ts') },
        // CommonJS output. Electron loads a CJS main reliably; a bare-file ESM
        // main did not execute its top-level in this environment.
        output: { format: 'cjs', entryFileNames: '[name].js' }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin({ include: ['electron'] })],
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        external: ['electron'],
        // The cage preload is the ONLY code that bridges the untrusted thing to
        // the trusted shell. Keep it a single, auditable file.
        // CommonJS: sandboxed preloads must be CommonJS, not ESM.
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].js' }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') }
      }
    }
  }
})
