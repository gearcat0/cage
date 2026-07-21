import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

// electron-vite splits the build into main, preload, and renderer bundles.
//
// This repo now builds TWO apps from shared modules:
//   out/main/index.js         — the cage test harness (the escape suite runs it)
//   out/main/shell/main.js     — the shell (trusted client)
//   out/main/shell/admission-worker.js — the isolated structural-decode worker
//
// The format code lives in this repo (src/format) and is bundled as source.
// @noble/* and zod are BUNDLED (not externalized) so the CJS main can use these
// ESM packages without runtime interop issues. `electron` and the native
// `better-sqlite3` stay external.
const BUNDLED = ['@noble/curves', '@noble/hashes', '@noble/ciphers', 'zod']
// `webtorrent` is an OPTIONAL, lazily-imported transport (magnet:); keep it
// external so the build never tries to bundle it when it is not installed.
const EXTERNAL = ['electron', 'better-sqlite3', 'webtorrent']

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: BUNDLED })],
    build: {
      outDir: 'out/main',
      rollupOptions: {
        external: EXTERNAL,
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'shell/main': resolve(__dirname, 'src/shell/main.ts'),
          'shell/admission-worker': resolve(__dirname, 'src/shell/admission/worker.ts')
        },
        // CommonJS output. Electron loads a CJS main reliably.
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
        // The cage preload (index) is the untrusted thing's surface; the shell
        // chrome preload is the TRUSTED chrome↔main bridge — distinct files.
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          'shell/chrome': resolve(__dirname, 'src/shell/chrome/preload.ts')
        },
        output: { format: 'cjs', entryFileNames: '[name].js' }
      }
    }
  },
  renderer: {
    // root is `src` so both the cage chrome (renderer/) and the shell chrome
    // (shell/chrome/) are under it. Emitted paths preserve the structure:
    //   out/renderer/renderer/index.html      (cage chrome)
    //   out/renderer/shell/chrome/index.html  (shell chrome)
    root: resolve(__dirname, 'src'),
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: {
          cage: resolve(__dirname, 'src/renderer/index.html'),
          shell: resolve(__dirname, 'src/shell/chrome/index.html')
        }
      }
    }
  }
})
