# src/AGENTS.md — Worker + WebGPU 投影実験の実装メモ

このディレクトリには「Worker で WebGPU 描画した結果を、メインの Three.js（WebGL）キャンバスに投影する」
実験が入っている。触る前にここを読むこと。

## ファイル構成

| パス | 役割 |
| --- | --- |
| `worker/gpuWorker.ts` | OffscreenCanvas + `WebGPURenderer`。コーネルボックスと GPU パーティクルを描画し、`ImageBitmap` を返す |
| `worker/protocol.ts` | メイン / Worker 共用のメッセージ型（DOM に依存させない） |
| `components/WorkerRenderPanel/index.tsx` | Worker 起動、カメラ行列の送信、`ImageBitmap` のテクスチャ化、カメラ追従パネルの描画 |
| `World.tsx` | `<WorkerRenderPanel />` を右下に配置 |

流れ: `useFrame` でメインカメラの `matrixWorldInverse` / `projectionMatrix` を送信 →
Worker が同じ視点で描画 → `transferToImageBitmap()` → `postMessage(bitmap, [bitmap])` →
メインで `Texture.image` に差し替えて板ポリに貼る。

## 必ず守ること

### 1. Worker の生成は Vite の `?worker` import 経由にする

```ts
import GpuWorker from '../../worker/gpuWorker.ts?worker'
const worker = new GpuWorker()
```

`new Worker(new URL('...', import.meta.url), { type: 'module' })` に戻すと `npx xrift check world` が
**REJECT** になる（`no-network-without-permission`）。

`@xrift/code-security` は `new Worker()` の **第 1 引数が文字列リテラルのときだけ** ドメインを検査し、
`new URL(...)` のような動的 URL は「権限未宣言の通信」として critical 判定する。
この判定は `world.permissions.network.allowedDomains` では回避できない（相対 URL リテラルなら通る）。
変更したら必ず `npx xrift check world` を実行すること。

### 2. ImageBitmap は flipY が効かない

Chrome の WebGL では `ImageBitmap` をソースにしたテクスチャに `UNPACK_FLIP_Y_WEBGL` が適用されない。
上下反転して見えるので、板ポリ側の UV を反転して対応している（`createPanelGeometry()`）。
`texture.flipY = false` にしても直らない。

### 3. 失敗してもメイン世界を壊さない

WebGPU 非対応環境では Worker が `error` を返し、パネルは `visible={false}` のままになる
（メインシーンは通常どおり動く）。この fail-safe を壊さないこと。

### 4. Worker の配信 URL は絶対パスになる

ビルド後は `new Worker("/gpuWorker-<hash>.js", ...)` のように `base` 基準の絶対パスが埋め込まれる。
XRift の CDN がサブパス配信の場合 404 になり、パネルが出ないだけ（エラーにはならない）。
実機で出すなら `vite.config.ts` の `base` を配信パスに合わせる必要がある。

### 5. Worker には requestAnimationFrame が無い

OffscreenCanvas を transfer していないため、Worker 側からは描画ループを回せない。
メインスレッドからの `frame` メッセージを描画トリガーにしており、**結果が返るまで次を送らない**
（1 フレーム 1 リクエスト）。この方式を崩すと遅延が溜まる。

### 6. バンドルサイズ

`three/webgpu` と `three/tsl` は Module Federation の `shared` 対象外なので、Worker チャンクに
まるごとインライン化される（約 2.2MB）。メインの `three`（WebGL）とは別インスタンスになるため、
シーンやジオメトリを共有することはできない。値・行列の受け渡しは `protocol.ts` 経由で行う。

### 7. XR では正しく合成されない

パネルはヘッド追従の板ポリなので、VR 中は目の前に浮く板になる。両眼で正しいステレオ合成をするには
per-eye の描画 / 合成が必要（現状は未対応）。

## 実装上のクセ

- `ImageBitmap` は使い終わったら `close()` する。メイン側は 1 フレーム遅らせて解放している
  （アップロード前に閉じると壊れるため）。
- パーティクルは TSL の `instancedArray` + `Fn().compute()` で GPU 上で更新する。
  描画は `SpriteNodeMaterial` の `positionNode = positions.toAttribute()` と `THREE.Sprite` の
  `count` でインスタンス数を指定する（r183 の API）。
- `Fn(...)().compute()` は `@types/three` に型が無いのでキャストしている（`ComputeTask`）。
- `shapeCircle()` の戻り値は `Node` 型なので `.mul()` が使えない。色側で明るさを調整する。
- カメラは `view` 行列から `matrix.decompose()` して `position/quaternion/scale` に反映する
  （`WebGPURenderer` が `matrixWorld` / `matrixWorldInverse` を再計算するため）。

## 調整ポイント

- `worker/gpuWorker.ts`: `PARTICLE_COUNT`、`particleMaterial.scaleNode`（粒の大きさ）、
  `flowX/Y/Z` の係数（流れ）、`toneMappingExposure`、ライトの強さ。
- `WorkerRenderPanel`: `coverage` / `anchor` / `margin`（画面内の位置と大きさ）、
  `maxWidth`（解像度上限）、`maxFps`、`enabled`。

## 動作確認

```bash
npm run typecheck
npm run dev                     # http://localhost:5173
npm run build && npx vite preview
npx xrift check world           # 23 files APPROVE になること
```

コンソールに `[worker-render] ready: ...` と、120 フレームごとの fps / Worker 描画時間が出る。
