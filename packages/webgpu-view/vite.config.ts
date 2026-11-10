import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'

/**
 * ライブラリビルド
 *
 * - メインスレッド用（three = WebGL）
 * - Worker 用（three/webgpu）
 * - 実験用（深度合成）
 *
 * を別エントリにしている。Worker 用の入口が React を読み込まないようにするため。
 * react / three / @react-three/fiber は利用者側のものを使う（external）。
 */
export default defineConfig({
  build: {
    target: 'esnext',
    minify: false,
    sourcemap: true,
    emptyOutDir: true,
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        'worker/index': resolve(__dirname, 'src/worker/index.ts'),
        'experimental/index': resolve(__dirname, 'src/experimental/index.ts'),
      },
      formats: ['es'],
    },
    rollupOptions: {
      external: (id) => /^(three|react|react-dom|@react-three\/fiber)(\/|$)/.test(id),
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
      },
    },
  },
  plugins: [
    dts({
      entryRoot: 'src',
      include: ['src'],
    }),
  ],
})
