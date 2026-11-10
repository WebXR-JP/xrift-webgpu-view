# src/AGENTS.md — WebGPU Worker ビューの実装メモ

このワールドは「Worker で WebGPU 描画した結果を、メインの Three.js（WebGL）キャンバスに出す」
デモ。仕組みは `packages/webgpu-view`（`@xrift/webgpu-view`）に切り出してある。

## ファイル構成

| パス | 役割 |
| --- | --- |
| `packages/webgpu-view/src/worker/defineGpuWorker.ts` | Worker 側ランタイム（レンダラ生成 / カメラ反映 / アトラス描画 / 転送） |
| `packages/webgpu-view/src/worker/types.ts` | シーン側の型（`GpuWorkerScene` / `GpuWorkerInit`） |
| `packages/webgpu-view/src/useGpuWorker.ts` | Worker 起動・行列送信・`ImageBitmap` → `Texture` |
| `packages/webgpu-view/src/GpuWorkerView.tsx` | カメラ追従の板ポリ（通常 / SBS / XR） |
| `packages/webgpu-view/src/experimental/DepthComposite.tsx` | 深度合成（実験・XR 非対応） |
| `src/worker/demoScene.ts` | デモのコーネルボックス + GPU パーティクル |
| `src/worker/demo.worker.ts` | `defineGpuWorker` を呼ぶだけの Worker エントリ |
| `src/World.tsx` | `USE_DEPTH_COMPOSITE` / `STEREO` で切り替え |

流れ: `useFrame` で視点カメラの `matrixWorldInverse` / `projectionMatrix` を送信 →
Worker が同じ視点で描画 → `transferToImageBitmap()` → `postMessage(bitmap, [bitmap])` →
メインで `Texture.image` に差し替える。

## 必ず守ること

### 1. Worker の生成は Vite の `?worker` import 経由にする

```ts
import DemoWorker from './worker/demo.worker.ts?worker'
```

`new Worker(new URL('...', import.meta.url), { type: 'module' })` に戻すと `npx xrift check world` が
**REJECT** になる（`no-network-without-permission`）。

`@xrift/code-security` は `new Worker()` の **第 1 引数が文字列リテラルのときだけ** ドメインを検査し、
`new URL(...)` のような動的 URL は「権限未宣言の通信」として critical 判定する。
変更したら必ず `npx xrift check world` を実行すること。

### 2. ライブラリの変更はビルドしてから使う

`@xrift/webgpu-view` は `dist` を参照している（npm workspaces）。`packages/` を編集したら

```bash
npm run build:lib   # npm run build -w @xrift/webgpu-view
```

`npm run dev` / `build` / `typecheck` は先頭で自動実行する（`predev` / `prebuild` / `pretypecheck`）。

### 3. tonemap は Worker 側で決める

`GpuWorkerView` は色をそのまま表示する（`toneMapping` は掛けない）。シーン側で
`renderer.toneMapping = ACESFilmicToneMapping` などを設定する。

`experimental/DepthComposite` だけは例外で、Worker は `NoToneMapping` にして
合成パス側で ACES を掛ける（`workerData={{ toneMapping: false }}`）。
ACES が線形でないため、深度を 8bit に詰めた色に掛けると値が壊れるため。

### 4. `ImageBitmap` は flipY が効かない

Chrome の WebGL では `ImageBitmap` をソースにしたテクスチャに `UNPACK_FLIP_Y_WEBGL` が適用されない。
上下反転して入るので、板ポリ側のシェーダで V を反転している（`1.0 - vUv.y`）。
`texture.flipY = false` にしても直らない。

### 5. 失敗してもメイン世界を壊さない

WebGPU 非対応環境では Worker が `error` を返し、スクリーンは `visible={false}` のままになる
（メインシーンは通常どおり動く）。この fail-safe を壊さないこと。

### 6. Worker の配信 URL は絶対パスになる

ビルド後は `new Worker("/demo-worker-<hash>.js", ...)` のように `base` 基準の絶対パスが埋め込まれる。
XRift の CDN がサブパス配信の場合 404 になり、スクリーンが出ないだけ（エラーにはならない）。
実機で出すなら `vite.config.ts` の `base` を配信パスに合わせる。

### 7. Worker には requestAnimationFrame が無い

OffscreenCanvas を transfer していないため、Worker 側からは描画ループを回せない。
メインスレッドからの `frame` メッセージを描画トリガーにしており、**結果が返るまで次を送らない**
（1 フレーム 1 リクエスト）。この方式を崩すと遅延が溜まる。

### 8. バンドルサイズ

`three/webgpu` と `three/tsl` は Module Federation の `shared` 対象外なので、Worker チャンクに
まるごとインライン化される（約 2.2MB）。メインの `three`（WebGL）とは別インスタンスになるため、
シーンやジオメトリを共有することはできない。値・行列の受け渡しは `protocol.ts` 経由で行う。

## ステレオと XR

`GpuWorkerView` は `stereo` でモニタでも 2 視点（SBS）になる。XR 中は自動で 2 視点。

- フレームメッセージは `views: ViewMatrices[]`（1 要素 = 単眼、2 要素 = 左右）。
- Worker は **アトラス**（横並び）で描く。キャンバスの横幅は「1 視点ぶん × 視点数」で、
  `setViewport` / `setScissor` で視点ごとに描き分ける（`applyViewCount` で必要時のみ resize）。
- **`renderer.setViewport` / `setScissor` は CSS ピクセル指定**。three が内部で `pixelRatio` を
  掛けるので、RT の実ピクセルを渡すと拡大されてズレる。
- モニタ確認用の SBS は「画角そのまま・横半分の解像度」で描く。画面の左右に同じ視野が
  横に縮んで並ぶ（`eyeSeparation` で眼間距離を調整できる）。

### XR でレイヤー分けは使えない

three の XR は **1 回の `render()` で両目を描く**。`projectObject` は ArrayCamera
（`cameraXR.layers.mask = camera.layers.mask | 0b110`）で 1 回だけ行われ、描画リストは
両目で共有される。そのため `mesh.layers.set(1)` / `set(2)` では目ごとに出し分けられない
（両目に両方のメッシュが描かれる）。

代わりに `GpuWorkerView` は **板ポリ 1 枚 + シェーダで目を判定**する。

- 描画中の `cameraPosition` / `viewMatrix` は目ごとに切り替わる。
- `dot(cameraPosition - uHeadPosition, right) > 0` なら右目（`right` は view 行列の 1 行目）。
- 目の位置でアトラスの左右半分を選ぶ。

### XR の視点と射影

- 視点は `gl.xr.getCamera().cameras[0..1]`（目の位置）。
- 射影行列は **左右共通（union）** を使う。スクリーンは 1 枚の板なので、画像が板全体に
  正しく貼れる。視差は目の位置の違いだけで付く。
- 板は両目の中間に置き、`cameraXR.projectionMatrix`（union）から視錐台の矩形を求めて
  大きさを合わせる（非対称フラスタムでも画面いっぱいになる）。
- 目のアスペクトが分かった時点で Worker の解像度を合わせ直す（`xrAspect` state）。

### XR の制約

- スクリーンはヘッドに追従する。3D の遮蔽はしない。
- **深度合成は XR ではできない**。WebXR のフレームバッファはブラウザが所有し、
  メインシーンを自分の RT に描いてから目ごとに合成する経路が無い。
  `DepthComposite` は XR 中 `gl.render(scene, camera)` にフォールバックする。

## 深度合成（experimental）

WebGL2 には `gl_FragDepth` が無いので、**深度を「書く」ことはできない**。
代わりに「メインシーンの深度」と「Worker の深度」をピクセルごとに比べて色を選ぶ。

1. メインシーンを `HalfFloatType` の `WebGLRenderTarget`（`DepthTexture` 付き）へ描く
2. 全画面クアッドで、ピクセルごとに Worker の色かシーンの色かを選ぶ
3. 選んだ色をメインキャンバスへ出力する

`useFrame(..., 1)` で R3F のレンダリングを乗っ取り、自分で `gl.render()` を呼ぶ。

### 深度の受け渡し

- Worker は同じ OffscreenCanvas を **2 回**描く。1 回目は色（そのまま）、2 回目は
  `scene.overrideMaterial` で距離を色に詰めた画像（`depthExclude` は非表示）。
- 距離は view 空間の `-z` を `DEPTH_RANGE`（50）で正規化し、**R,G に 16bit**でパックする。
  R,G = 0 は「描画なし」の意味。8bit 1 枚では精度が足りず、等高線状の縞が出る。
- 2 枚を `transferToImageBitmap()` して `depthBitmap` として一緒に送る。
- `transferToImageBitmap()` は canvas の内容を消費するので「深度 → transfer → 色 → transfer」の順。

### 色の扱い（ハマりどころ）

- **sRGB テクスチャはサンプル時にハードウェアでリニアに戻る**（three は内部フォーマットを
  `SRGB8_ALPHA8` にする）。合成パスで `sRGBToLinear()` を掛けると二重デコードで暗くなる。
- シーン色（RT）はリニア + トーンマップ前なので、合成パスでレンダラと同じ
  トーンマップ + sRGB エンコードを行う（`uToneMapping` は `renderer.toneMapping` から渡す）。

### その他

- Worker の部屋は `ROOM_LIFT`（6cm）だけ浮かせている。メイン世界の地面も y=0 なので、
  そのままだと床同士が同一平面になり縞（z-fighting）が出る。
- パーティクルは深度を書かないものとして深度パスから外している。そのためパーティクルは
  「背後の面の深度」で合成され、手前の遮蔽物に正しく隠れない（仕様として許容）。
- `debug` prop: `1` 距離 / `2` パックした生バイト / `3` Worker の色のみ /
  `4` 採用マスク（緑 = Worker, 赤 = シーン）/ `5` アトラス全体。

## 実装上のクセ

- `ImageBitmap` は使い終わったら `close()` する。メイン側は 1 フレーム遅らせて解放している
  （アップロード前に閉じると壊れる）。
- `sRGBTransferEOTF()` で深度パス出力を事前に打ち消している（出力段で sRGB エンコードされるため）。
- パーティクルは TSL の `instancedArray` + `Fn().compute()` で GPU 上で更新する。
  描画は `SpriteNodeMaterial` の `positionNode = positions.toAttribute()` と `THREE.Sprite` の
  `count` でインスタンス数を指定する（r183 の API）。
- `Fn(...)().compute()` は `@types/three` に型が無いのでキャストしている（`ComputeTask`）。
- カメラは `view` 行列から `matrix.decompose()` して `position/quaternion/scale` に反映する
  （`WebGPURenderer` が `matrixWorld` / `matrixWorldInverse` を再計算するため）。

## 調整ポイント

- `src/worker/demoScene.ts`: `PARTICLE_COUNT`、`particleMaterial.scaleNode`（粒の大きさ）、
  `flowX/Y/Z` の係数（流れ）、`renderer.toneMappingExposure`、ライトの強さ。
- `GpuWorkerView`: `coverage` / `anchor` / `margin` / `distance` / `maxWidth` / `resolutionScale` /
  `maxFps` / `stereo` / `depthTest`。
- `DepthComposite`: `stereo` / `maxWidth` / `resolutionScale` / `maxFps` / `debug`。
  Worker の露出は `uWorkerExposure`（既定 1.15）。

## 検証手順

```bash
npm run typecheck
npm run dev                     # http://localhost:5173
npm run build && npx vite preview
npx xrift check world           # 24 files APPROVE になること
```

`debug` を付けるとコンソールに `[webgpu-view] ready: ...` と fps が出る。

深度合成が壊れたときは、まず `debug` を切り替えて切り分ける。

| 症状 | 見るもの |
| --- | --- |
| 全面がシーン / 全面が Worker | `debug={4}` のマスク |
| 縞・ノイズ状のまだら | `debug={1}` で深度が滑らかか（粗ければパック精度かエンコード） |
| 色が暗い / 白飛び | `debug={3}` で Worker の素の色を確認 |

XR は実機（PICO 4 など）が必要。WebXR は secure context 必須なので HTTPS で配信すること。
未検証の経路を触ったら、その旨をコミットメッセージに書く。
