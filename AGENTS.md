# AGENTS.md — @webxr-jp/webgpu-view

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
├── package.json          # @webxr-jp/webgpu-view（workspaces: examples/*）
└── examples/world/       # テスト用ワールド（@webxr-jp/webgpu-view-example / private）
```

| エントリ | 中身 |
| --- | --- |
| `@webxr-jp/webgpu-view` | `GpuBackdrop` / `useGpuWorker` / 通信型 |
| `@webxr-jp/webgpu-view/worker` | `defineGpuWorker` と型（React を巻き込まない） |
| `@webxr-jp/webgpu-view/experimental` | `DepthComposite`（安定 API ではない） |

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

`examples/world` は `@webxr-jp/webgpu-view` を `file:../..` で参照している。
`examples/world` 内で `npm run dev` しても `predev` がリポジトリ直下のライブラリをビルドする。

## 必ず守ること

1. **`src/` にデモ固有のコードを入れない。** デモは `examples/world` 側に置く。
2. **公開 API を変えたらルートの `README.md` と `examples/world` の利用箇所も直す。**
   型シグネチャ（`GpuWorkerScene` / `GpuWorkerUpdateContext` / `GpuBackdropProps`）の
   追加分は README の API 節にも反映し、`examples/world` は後方互換の確認用として
   既定の挙動を変えずにビルドが通ること。
3. **`react` / `three` / `@react-three/fiber` は external。** バンドルに含めない
   （`vite.config.ts` の `rollupOptions.external`）。
4. **library は Worker を生成しない。** 生成は利用者側の `?worker` import に任せる
   （`new Worker(new URL(...))` は `@xrift/code-security` が REJECT するため）。
5. **`dist` は参照される成果物。** ソースだけ変えても `examples/world` には反映されない。
   `examples/world` で確認するときは直下のライブラリを先にビルドする
   （`example:dev` / `predev` が面倒を見る）。
6. **Worker の描画経路（`bitmap` / `buffer`）を変えたら両方で確認する。**
   カスタム描画フックは両経路で同じフックを使う（buffer では `setRenderTarget` 済みが前提）。
   深度パス（`DepthComposite`、`depth: true`）は `scene` の直接描画のままにし、
   カスタム描画の対象はカラーパスのみにする。
7. **XR の写像（シェーダ）を変えたら式と場所を残す。** 板ポリのフラグメント
   （`GpuBackdrop.tsx` の `reprojectUv` / `uMono` 分岐など）と対応する CPU 側
   （視点の解決・uniform の更新）を同時に直し、実機未検証の経路はその旨を明記する。
   `xrMono` の再写像は必須なので `reproject` の ON/OFF より優先される。
8. **ワールド固有の実装メモ** は `examples/world/AGENTS.md` と
   `examples/world/src/AGENTS.md` にある（描画順 / XR / 深度合成のハマりどころ）。

## 検証

```bash
npm run check                                  # 型 + ビルド（本体 / ワールド）
cd examples/world && npx xrift check world     # セキュリティチェック（APPROVE になること）
```

XR は実機（PICO 4 など）が必要。未検証の経路を触ったら、その旨をコミットメッセージに書く。

## リリース

npm への公開は **`v*` タグの push** でのみ行う（`.github/workflows/publish.yml`）。
`npm publish` を手元で叩かない（タグとバージョンの一致・provenance が CI 側で担保される）。

認証は **Trusted Publishing（OIDC）**。`NPM_TOKEN` などのトークンは使わない。
npmjs.com のパッケージ Settings > Trusted publishing で
`WebXR-JP` / `xrift-webgpu-view` / `publish.yml` を登録し、**`npm publish` を許可**しておく
（既定は `npm stage publish` のみ）。設定は最初の publish から 2 日で失効するので、
作成したらすぐタグを push する。

```bash
npm version patch      # package.json / lock 更新 + コミット + vX.Y.Z タグ
git push --follow-tags # タグ push が publish のトリガー
```
