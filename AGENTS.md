# AGENTS.md — @xrift/webgpu-view

Worker の中で WebGPU（three.js の `WebGPURenderer`）で描いたシーンを `ImageBitmap` として受け取り、
React Three Fiber のキャンバスの **全画面の背景** として出すライブラリ。

**このリポジトリはパッケージ本体が主**で、`examples/world` は動作確認用の XRift ワールド（テスト用）。

## 構成

```
.
├── src/                  # ライブラリ本体（公開 API）
│   ├── index.ts          #   メイン入口
│   ├── GpuBackdrop.tsx   #   全画面の背景（NDC の板ポリ）
│   ├── useGpuWorker.ts   #   Worker 起動・行列送信・Texture 更新
│   ├── protocol.ts       #   メイン ⇔ Worker のメッセージ型
│   ├── worker/           #   Worker 入口（defineGpuWorker）
│   └── experimental/     #   DepthComposite（深度合成・実験）
├── vite.config.ts        # ライブラリビルド（3 エントリ / ESM + d.ts）
├── package.json          # @xrift/webgpu-view（workspaces: examples/*）
└── examples/world/       # テスト用ワールド（@xrift/webgpu-view-example / private）
```

| エントリ | 中身 |
| --- | --- |
| `@xrift/webgpu-view` | `GpuBackdrop` / `useGpuWorker` / 通信型 |
| `@xrift/webgpu-view/worker` | `defineGpuWorker` と型（React を巻き込まない） |
| `@xrift/webgpu-view/experimental` | `DepthComposite`（安定 API ではない） |

## コマンド

```bash
npm install
npm run build           # ライブラリを dist/ にビルド
npm run typecheck
npm run dev             # watch ビルド

npm run example:dev     # ライブラリをビルドして examples/world を起動
npm run example:build
npm run example:typecheck
npm run example:upload  # XRift にアップロード（要 xrift login）
npm run check           # 本体 + ワールドの型チェックとビルド
```

`examples/world` は `@xrift/webgpu-view` を `file:../..` で参照している。
`examples/world` 内で `npm run dev` しても `predev` がリポジトリ直下のライブラリをビルドする。

## 必ず守ること

1. **`src/` にデモ固有のコードを入れない。** デモは `examples/world` 側に置く。
2. **公開 API を変えたらルートの `README.md` と `examples/world` の利用箇所も直す。**
3. **`react` / `three` / `@react-three/fiber` は external。** バンドルに含めない
   （`vite.config.ts` の `rollupOptions.external`）。
4. **library は Worker を生成しない。** 生成は利用者側の `?worker` import に任せる
   （`new Worker(new URL(...))` は `@xrift/code-security` が REJECT するため）。
5. **`dist` は参照される成果物。** ソースだけ変えても `examples/world` には反映されない。
6. **ワールド固有の実装メモ** は `examples/world/AGENTS.md` と
   `examples/world/src/AGENTS.md` にある（描画順 / XR / 深度合成のハマりどころ）。

## 検証

```bash
npm run check                                  # 型 + ビルド（本体 / ワールド）
cd examples/world && npx xrift check world     # セキュリティチェック（APPROVE になること）
```

XR は実機（PICO 4 など）が必要。未検証の経路を触ったら、その旨をコミットメッセージに書く。
