# @webxr-jp/webgpu-view

Worker の中で WebGPU（three.js の `WebGPURenderer`）で描いたシーンを `ImageBitmap` として受け取り、
React Three Fiber のキャンバスの **全画面の背景** として出すためのライブラリ。

Skybox の置き換えを想定している。

このリポジトリは **パッケージ本体（リポジトリ直下）が主**で、`examples/world/` は
動作確認用の XRift ワールド（テスト用）。

- **通常（モニタ）**: 画面全体を覆う板ポリをシーンより先に描く
- **XR**: 左右の目ぶんを 1 フレームで描き（アトラス）、目ごとのビューポートいっぱいに出す
- **深度は書かない**: メインシーンのオブジェクトは常に手前（背景より奥には何も描かれない）
- 深度を比較して合成する実験は `@webxr-jp/webgpu-view/experimental` に分けてある（XR 非対応）

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
npm install @webxr-jp/webgpu-view
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
import { defineGpuWorker } from '@webxr-jp/webgpu-view/worker'

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
import { GpuBackdrop } from '@webxr-jp/webgpu-view'
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

### XRift の Enter VR

XRift の「Enter VR」は、ホスト側の `WebGLRenderer` に WebXR セッションを張る。
React Three Fiber は `gl.xr` の `sessionstart` / `sessionend` を購読していて、
セッション中は `advance()` でフレームを回す（`useFrame` も動く）。

`GpuBackdrop` は毎フレーム `gl.xr.isPresenting` を見ているだけなので、
**ワールド側の追加コードなしで自動的に切り替わる**。

- Enter VR → 2 視点（目ごとの射影行列）で描画、`uPerEye` が有効になる
- VR を終了 → 単眼に戻り、Worker の解像度も戻る

ローカルの `DevEnvironment` には Enter VR が無い。VR はプラットフォームに
アップロードして確認する（自前で試すなら `navigator.xr.requestSession()` の結果を
`gl.xr.setSession(session)` に渡す）。
深度を比較して合成する方式（`experimental/DepthComposite`）は WebXR では動かない。
WebXR のフレームバッファはブラウザが所有しており、メインシーンを自分の RT に描いてから
目ごとに合成する経路が無いため。

## 実験機能（`@webxr-jp/webgpu-view/experimental`）

```tsx
import { DepthComposite } from '@webxr-jp/webgpu-view/experimental'

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
- **ウィンドウのリサイズで画像サイズが変わると、テクスチャを作り直す**。
  three は同じ `Source` のまま画像だけ差し替えると最初に確保した領域を使い回すため、
  画像が大きくなると転送がはみ出して `GL_INVALID_VALUE` になり、**背景が固まる**
  （フレームは届いているのにテクスチャが更新されない）。`useGpuWorker` がサイズ変化を
  検出して `Source` ごと作り直す。自前で `colorTexture` を扱う場合も同じ注意が必要。
- **バンドルサイズ**: `three/webgpu` は Module Federation の `shared` 対象外なので、
  Worker チャンクに `three/webgpu` が丸ごと入る（約 2.2MB）。メインの `three`（WebGL）とは
  別インスタンスになるので、シーンやジオメトリは共有できない。
- **Worker の配信 URL は絶対パス**（`/xxx-worker-<hash>.js`）。CDN がサブパス配信の場合は
  `vite.config.ts` の `base` を合わせる。合わないと背景が出ないだけ（メイン世界は動く）。
- WebGPU 非対応の環境では Worker が `error` を返し、背景は非表示のまま。
  メインシーンは通常どおり動く（fail-safe）。
- 背景はカメラに追従する（視差なし）。ワールドに固定したい場合は `useGpuWorker` を
  使って自前の板ポリに `colorTexture` を貼る。

## リポジトリ構成

パッケージ本体がリポジトリ直下、動作確認用のワールドが `examples/` にある。

```
webgpu-test/
├── src/                  # ライブラリ本体
│   ├── GpuBackdrop.tsx   # 全画面の背景
│   ├── useGpuWorker.ts   # Worker 起動・行列送信・Texture 更新
│   ├── protocol.ts       # メイン ⇔ Worker のメッセージ型
│   ├── worker/           # defineGpuWorker（Worker ランタイム）
│   └── experimental/     # DepthComposite（深度合成・実験）
├── vite.config.ts        # ライブラリビルド（3 エントリ）
├── package.json          # @webxr-jp/webgpu-view（workspaces: examples/*）
└── examples/
    └── world/            # テスト用の XRift ワールド
        ├── src/          # World.tsx / worker/demo.worker.ts / demoScene.ts
        ├── xrift.json
        └── package.json  # @webxr-jp/webgpu-view-example（private）
```

## 開発

```bash
npm install

# ライブラリ
npm run build        # dist/ に ESM + d.ts
npm run typecheck
npm run dev          # 変更を watch して dist を更新

# 動作確認（テスト用ワールド）
npm run example:dev      # ライブラリをビルドしてワールドを起動
npm run example:build
npm run example:upload   # XRift にアップロード（要 xrift login）
npm run check            # 本体 + ワールドの型チェックとビルド
```

`examples/world` は `@webxr-jp/webgpu-view` を `file:../..` で参照している（npm workspaces）。
`examples/world` 内で `npm run dev` しても、`predev` がリポジトリ直下のライブラリをビルドする。

アプリ側から `dist` を参照している場合、`npm run dev`（watch）で書き換えると
Vite の HMR が乱れて画面が真っ白になることがある。そのときはブラウザを再読み込みする。

`dist` は `index.js`（メイン）/ `worker/index.js`（Worker）/ `experimental/index.js`（実験）の
3 エントリ。`react` / `three` / `@react-three/fiber` は external。

## リリース（npm publish）

`v*` タグの push で `.github/workflows/publish.yml` が走り、npm へ publish する。
認証は **Trusted Publishing（OIDC）** で、長期トークンは使わない（provenance も自動）。

```bash
# 1. バージョンを上げる（コミットと vX.Y.Z タグも作られる）
npm version patch     # 例: 0.1.0 -> 0.1.1（minor / major も同じ）

# 2. タグごと push（タグ push が publish のトリガー）
git push --follow-tags
```

ワークフローは次を確認してから publish する。

- タグ名（`v` を除く）と `package.json` の `version` が一致すること
- `npm run typecheck` / `npm run build` が通ること

### 初回だけ必要な設定（npmjs.com）

パッケージの Settings > **Trusted publishing** > GitHub Actions に登録する。

| 項目 | 値 |
| --- | --- |
| Organization or user | `WebXR-JP` |
| Repository | `xrift-webgpu-view` |
| Workflow filename | `publish.yml`（パスではなくファイル名） |
| Environment name | 空でよい |
| Allowed actions | **`npm publish` を許可する** |

- 「Allowed actions」は 2026-09-03 以降に作った設定では既定が `npm stage publish` のみで、
  `npm publish` は無効。チェックを入れないと publish で失敗する。
- 設定は最初の publish が成功して初めて有効になる。**作成から 2 日以内**にタグを push すること
  （過ぎると設定が失効し、作り直しになる）。
- 登録内容は保存時に検証されない。workflow 名・リポジトリ名の typo は publish 時に
  `ENEEDAUTH` として出る。`package.json` の `repository.url` と GitHub のリポジトリが
  一致している必要がある。

トークン方式（`NPM_TOKEN`）は使わない。CI からの公開は trusted publishing に一本化する。

