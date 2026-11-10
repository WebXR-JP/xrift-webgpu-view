# @xrift/webgpu-view

Worker の中で WebGPU（three.js の `WebGPURenderer`）で描いたシーンを `ImageBitmap` として受け取り、
React Three Fiber のキャンバスの **全画面の背景** として出すためのライブラリ。

Skybox の置き換えを想定している。

- **通常（モニタ）**: 画面全体を覆う板ポリをシーンより先に描く
- **XR**: 左右の目ぶんを 1 フレームで描き（アトラス）、目ごとのビューポートいっぱいに出す
- **深度は書かない**: メインシーンのオブジェクトは常に手前（背景より奥には何も描かれない）
- 深度を比較して合成する実験は `@xrift/webgpu-view/experimental` に分けてある（XR 非対応）

```
メインスレッド                        Worker
┌──────────────────────┐   frame   ┌────────────────────────┐
│ カメラ行列 (mono/XR)  │ ────────▶ │ WebGPURenderer          │
│                      │           │  scene ← 利用者のコード   │
│ Texture ◀────────────┼─ bitmap ──│  viewport を横に並べて描く │
│ 全画面の板ポリ        │           └────────────────────────┘
│ (renderOrder -1000)  │
└──────────────────────┘
   ↑ これを最初に描き、メインシーンがその上に乗る
```

## インストール

```bash
npm install @xrift/webgpu-view
```

peer: `react` >= 19 / `three` >= 0.183 / `@react-three/fiber` >= 9

## 使い方

### 1. Worker のエントリを書く

`defineGpuWorker` にシーンを作る関数を渡すだけ。レンダラの生成、カメラ行列の反映、
視点ぶんの描画、`ImageBitmap` の転送はライブラリが行う。

```ts
// my.worker.ts
import {
  ACESFilmicToneMapping,
  BoxGeometry,
  Mesh,
  MeshStandardNodeMaterial,
  Scene,
} from 'three/webgpu'
import { defineGpuWorker } from '@xrift/webgpu-view/worker'

defineGpuWorker(({ renderer }) => {
  const scene = new Scene()

  const cube = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardNodeMaterial())
  scene.add(cube)

  // トーンマップは Worker 側で決める（ビュー側はそのまま表示する）
  renderer.toneMapping = ACESFilmicToneMapping

  return {
    scene,
    // 毎フレーム、描画の直前に呼ばれる
    update: ({ time }) => {
      cube.rotation.y = time
    },
    // ready メッセージに載る任意の情報
    meta: { objects: 1 },
  }
})
```

### 2. コンポーネントを置く

```tsx
import { GpuBackdrop } from '@xrift/webgpu-view'
import MyWorker from './my.worker.ts?worker'

export const World = () => (
  <>
    <ambientLight />
    <GpuBackdrop worker={MyWorker} />
  </>
)
```

`?worker` は **利用者側のコード** に書く（Vite が Worker チャンクを作る）。
`new Worker(new URL(...))` は `npx xrift check world` に REJECT されるので使わない。

## 描画順（背景として置く）

板ポリは `renderOrder = -1000`、`depthTest = false`、`depthWrite = false` で描かれる。
つまり **シーンの中で最初に描かれ、他のオブジェクトはすべてその上に乗る**。

- 既存の Skybox を残したい場合は、Skybox 側の `renderOrder` をさらに小さくする
  （例: `-2000`）。WebGPU が使えない環境では Skybox が見える、というフォールバックになる。
- すでに `renderOrder` に -1000 未満を使っているオブジェクトがあると、その物体は
  背景の下に潜る。
- メインシーンの透明物は背景の上に描かれる（深度は書いていないので前後関係は常に「奥」）。

## API

### `GpuBackdrop`

| prop | 既定 | 説明 |
| --- | --- | --- |
| `worker` | — | `?worker` import の既定エクスポート |
| `workerData` | — | Worker 起動時に 1 回だけ渡す任意のデータ（`init.data`） |
| `maxWidth` | `1280` | Worker の解像度上限（1 視点ぶんの横幅 px） |
| `resolutionScale` | `1` | `devicePixelRatio` に掛ける |
| `maxFps` | `60` | Worker を描画する最大頻度 |
| `enabled` | `true` | `false` で停止（背景が消える） |
| `stereo` | `false` | モニタでも 2 視点（SBS）。XR 中は自動で 2 視点 |
| `eyeSeparation` | `0.064` | SBS の眼間距離（m） |
| `onReady` / `onError` | — | `{ backend, adapter, width, height, meta }` / エラーメッセージ |
| `debug` | `false` | コンソールに ready と fps を出す |

### `defineGpuWorker(factory)`

`factory(init) => GpuWorkerScene | Promise<GpuWorkerScene>`

```ts
interface GpuWorkerInit {
  width: number   // 1 視点ぶんの幅（px）
  height: number
  renderer: WebGPURenderer
  canvas: OffscreenCanvas
  data?: unknown  // workerData
}

interface GpuWorkerScene {
  scene: Scene
  update?: (ctx: { time, delta, viewCount, renderer }) => void | Promise<void>
  warmup?: (camera: PerspectiveCamera) => void  // 最初のフレームまでの見た目
  meta?: Record<string, unknown>
  dispose?: () => void
  /** @internal 深度パスから外すオブジェクト（experimental 用） */
  depthExclude?: Object3D[]
}
```

- カメラはライブラリが作る。`init` では渡ってこないので、必要なら `update` の
  `renderer` と自分の uniform で完結させる。
- `update` は描画の直前に呼ばれる。パーティクルの compute などはここで。
- `warmup` を省略すると `(0, 1.7, 8)` から原点方向を見た 1 フレームが描かれる。

### `useGpuWorker`

`GpuBackdrop` の中身。テクスチャだけ欲しい / 自分で板ポリを貼りたい場合はこちら。

```ts
const { colorTexture, hasFrame, error } = useGpuWorker({
  worker: MyWorker,
  width, height,
  getViewCameras: (state) => [state.camera], // 1 要素 = 単眼 / 2 要素 = ステレオ
})
```

`colorTexture` は `ImageBitmap` 由来で **上下が反転している**。貼るときは V を反転する。

## XR の挙動

XR 中はブラウザが用意した目のカメラをそのまま使い、**左右の目ぶんを 1 フレームで
横に並べて描く**（アトラス）。

- 板ポリはスクリーン空間（NDC）の四角形で、目ごとのビューポートをそのまま覆う。
  射影を通さないので、非対称なフラスタムでも隙間が出ない。
- シェーダが `cameraPosition`（目ごとに切り替わる）からどちらの目かを判定し、
  アトラスの該当半分を引く。three の XR は 1 回の `render()` で両目を描くが、
  そのとき `viewMatrix` / `cameraPosition` は目ごとに切り替わる。
- Worker には **目ごとの射影行列** を送る。画像はその目のビューポートいっぱいに貼るので、
  メインシーンと画角が一致する。
- 目のアスペクトが分かった時点で Worker の解像度を合わせ直す。

3D の遮蔽はしない。WebGPU のシーンは常にメインシーンより奥になる。
深度を比較して合成する方式（`experimental/DepthComposite`）は WebXR では動かない。
WebXR のフレームバッファはブラウザが所有しており、メインシーンを自分の RT に描いてから
目ごとに合成する経路が無いため。

## 実験機能（`@xrift/webgpu-view/experimental`）

```tsx
import { DepthComposite } from '@xrift/webgpu-view/experimental'

<DepthComposite worker={MyWorker} stereo={false} debug={0} />
```

メインシーンを HDR の RT に描き、全画面クアッドで「シーン色」と「Worker の色」を
ピクセルごとに選ぶ。WebGL2 に `gl_FragDepth` が無いため、深度を「書く」のではなく
深度を比較して色を選んでいる。

- XR では動かない（上記）
- Worker 側は `renderer.toneMapping = NoToneMapping` にして、合成パスで ACES を掛ける前提
- `debug`: `1` 距離 / `2` パックした生バイト / `3` Worker の色のみ /
  `4` 採用マスク（緑 = Worker, 赤 = シーン）/ `5` アトラス全体

## 注意点

- **Worker の生成は `?worker` import 経由**にする。`new Worker(new URL(...))` は
  `@xrift/code-security` が「権限未宣言の通信」として弾く。
- **`ImageBitmap` は `flipY` が効かない**。テクスチャは上下反転で入る。
- **バンドルサイズ**: `three/webgpu` は Module Federation の `shared` 対象外なので、
  Worker チャンクに `three/webgpu` が丸ごと入る（約 2.2MB）。メインの `three`（WebGL）とは
  別インスタンスになるので、シーンやジオメトリは共有できない。
- **Worker の配信 URL は絶対パス**（`/xxx-worker-<hash>.js`）。CDN がサブパス配信の場合は
  `vite.config.ts` の `base` を合わせる。合わないと背景が出ないだけ（メイン世界は動く）。
- WebGPU 非対応の環境では Worker が `error` を返し、背景は非表示のまま。
  メインシーンは通常どおり動く（fail-safe）。
- 背景はカメラに追従する（視差なし）。ワールドに固定したい場合は `useGpuWorker` を
  使って自前の板ポリに `colorTexture` を貼る。

## 開発

```bash
npm install
npm run build        # dist/ に ESM + d.ts
npm run typecheck
```

アプリ側から `dist` を参照している場合、`npm run dev`（watch）で書き換えると
Vite の HMR が乱れて画面が真っ白になることがある。そのときはブラウザを再読み込みする。

`dist` は `index.js`（メイン）/ `worker/index.js`（Worker）/ `experimental/index.js`（実験）の
3 エントリ。`react` / `three` / `@react-three/fiber` は external。
