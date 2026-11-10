# @xrift/webgpu-view

Worker の中で WebGPU（three.js の `WebGPURenderer`）で描いたシーンを `ImageBitmap` として受け取り、
React Three Fiber のキャンバスに「カメラ追従のスクリーン」として出すためのライブラリ。

- **通常（モニタ）**: カメラの視錐台に合わせた板ポリに貼る。画面いっぱいにもパネルにもできる
- **XR**: 左右の目ぶんを 1 フレームで描き（アトラス）、両眼に正しいステレオで出す
- **深度合成はしない**: メインシーンとの前後関係は「スクリーンとして手前に出す」だけ。
  深度合成は `@xrift/webgpu-view/experimental` に内部実験として置いてある（XR 非対応）

```
メインスレッド                        Worker
┌──────────────────────┐   frame   ┌────────────────────────┐
│ カメラ行列 (mono/XR)  │ ────────▶ │ WebGPURenderer          │
│                      │           │  scene ← 利用者のコード   │
│ Texture ◀────────────┼─ bitmap ──│  viewport を横に並べて描く │
│ 板ポリ (1 枚)         │           └────────────────────────┘
└──────────────────────┘
   XR は目の位置でアトラスの左右を選ぶ
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
import { GpuWorkerView } from '@xrift/webgpu-view'
import MyWorker from './my.worker.ts?worker'

export const World = () => (
  <>
    <ambientLight />
    <GpuWorkerView worker={MyWorker} coverage={0.6} anchor="bottom-right" />
  </>
)
```

`?worker` は **利用者側のコード** に書く（Vite が Worker チャンクを作る）。
`new Worker(new URL(...))` は `npx xrift check world` に REJECT されるので使わない。

## API

### `GpuWorkerView`

| prop | 既定 | 説明 |
| --- | --- | --- |
| `worker` | — | `?worker` import の既定エクスポート |
| `workerData` | — | Worker 起動時に 1 回だけ渡す任意のデータ（`init.data`） |
| `coverage` | `0.6` | 画面に対する大きさ。`1` で画面いっぱい |
| `anchor` | `'center'` | `'top-left' \| 'top-right' \| 'bottom-left' \| 'bottom-right'` |
| `margin` | `0.03` | 画面端からの余白（NDC。1 で画面の半分） |
| `distance` | `1` | カメラからの距離（m）。見た目の大きさは `coverage` で決まる |
| `maxWidth` | `1280` | Worker の解像度上限（1 視点ぶんの横幅 px） |
| `resolutionScale` | `1` | `devicePixelRatio` に掛ける |
| `maxFps` | `60` | Worker を描画する最大頻度 |
| `enabled` | `true` | `false` で停止（最後のフレームを保持） |
| `stereo` | `false` | モニタでも 2 視点（SBS）。XR 中は自動で 2 視点 |
| `eyeSeparation` | `0.064` | SBS の眼間距離（m） |
| `depthTest` | `false` | `true` にするとシーンの手前の物で隠れる |
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

`GpuWorkerView` の中身。テクスチャだけ欲しい / 自分で板ポリを貼りたい場合はこちら。

```ts
const { colorTexture, hasFrame, error } = useGpuWorker({
  worker: MyWorker,
  width, height,
  getViewCameras: (state) => [state.camera], // 1 要素 = 単眼 / 2 要素 = ステレオ
})
```

`colorTexture` は `ImageBitmap` 由来で **上下が反転している**。貼るときは V を反転する。

## XR の挙動

XR 中はブラウザが用意した目のカメラを使い、**左右の目ぶんを 1 フレームで横に並べて描く**
（アトラス）。メイン側の板ポリは 1 枚で、シェーダが `cameraPosition`（目ごとに切り替わる）から
どちらの目かを判定してアトラスの該当半分を引く。

- スクリーンはヘッドの前方に置かれる（頭に追従する）
- 3D の遮蔽はしない。メインシーンの物はスクリーンより奥でも手前に描かれない
- 視差は「目の位置の違い」で付く。両目の射影行列は共通（union）にしてある
- 目のアスペクトが分かった時点で Worker の解像度を合わせ直す

深度合成（メインシーンとピクセル単位で前後を比較する方式）は WebXR では動かない。
WebXR のフレームバッファはブラウザが所有しており、メインシーンを自分の RT に描いてから
目ごとに合成する経路が無いため。XR 中は合成せず通常描画にフォールバックする。

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
  `vite.config.ts` の `base` を合わせる。合わないとパネルが出ないだけ（メイン世界は動く）。
- WebGPU 非対応の環境では Worker が `error` を返し、スクリーンは非表示のまま。
  メインシーンは通常どおり動く（fail-safe）。
- **`renderer.setViewport` / `setScissor` は CSS ピクセル指定**。three が内部で
  `pixelRatio` を掛けるので、RT の実ピクセルを渡すとズレる。
- スクリーンはカメラに追従する。ワールドに固定したい場合は `enabled` と併用して
  自前の板ポリに `colorTexture` を貼る（`useGpuWorker` を使う）。

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
