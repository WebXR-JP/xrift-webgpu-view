# src/AGENTS.md — Worker + WebGPU 投影実験の実装メモ

このディレクトリには「Worker で WebGPU 描画した結果を、メインの Three.js（WebGL）キャンバスに投影する」
実験が入っている。触る前にここを読むこと。

## ファイル構成

| パス | 役割 |
| --- | --- |
| `worker/gpuWorker.ts` | OffscreenCanvas + `WebGPURenderer`。コーネルボックスと GPU パーティクルを描画し、色（+ 深度）の `ImageBitmap` を返す |
| `worker/protocol.ts` | メイン / Worker 共用のメッセージ型（DOM に依存させない） |
| `gpu-worker/useGpuWorker.ts` | Worker の起動 / カメラ行列の送信 / `ImageBitmap` のテクスチャ化（パネルと深度合成で共用） |
| `components/WorkerRenderPanel/index.tsx` | カメラ追従パネルに投影（深度なしのリファレンス実装） |
| `components/DepthComposite/index.tsx` | メインシーンと深度合成して全画面に描く |
| `World.tsx` | `USE_DEPTH_COMPOSITE` で上の 2 つを切り替える |

流れ: `useFrame` でメインカメラの `matrixWorldInverse` / `projectionMatrix` を送信 →
Worker が同じ視点で描画 → `transferToImageBitmap()` → `postMessage(bitmap, [bitmap])` →
メインで `Texture.image` に差し替えて使う。

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

## 深度合成（DepthComposite）

WebGL2 には `gl_FragDepth` が無いので、**深度を「書く」ことはできない**。
代わりに「メインシーンの深度」と「Worker の深度」をピクセルごとに比べて色を選ぶ。

1. メインシーンを `HalfFloatType` の `WebGLRenderTarget`（`DepthTexture` 付き）へ描く
2. 全画面クアッドで、ピクセルごとに Worker の色かシーンの色かを選ぶ
3. 選んだ色をメインキャンバスへ出力する

そのため `useFrame(..., 1)` で R3F のレンダリングを乗っ取り、自分で `gl.render()` を呼ぶ。
XR 中は合成できないので通常描画へフォールバックする。

### 深度の受け渡し

- Worker は同じ OffscreenCanvas を **2 回**描く。1 回目は可視化用の色（そのまま）、
  2 回目は `scene.overrideMaterial` で距離を色に詰めた画像。
- 距離は view 空間の `-z` を `DEPTH_RANGE`（50）で正規化し、**R,G に 16bit**でパックする。
  R,G = 0 は「描画なし」の意味。8bit 1 枚では精度が足りず、等高線状の縞が出る。
- 2 枚を `transferToImageBitmap()` して `depthBitmap` として一緒に送る。
- メイン側は R,G を `(hi*256+lo)/65535` で戻し、`uDepthRange` を掛けて距離に戻す。

### 色の扱い（ハマりどころ）

- **Worker のレンダラは `toneMapping = NoToneMapping` 固定**。理由は 2 つ:
  - `toneMapping` はレンダラ単位の設定で、切り替えると他のマテリアルのビルドにも影響する
    （深度パスだけトーンマップを切ろうとするとカラーパスまで暗くなる）
  - ACES は非線形なので、深度をパックした色が壊れる
- 代わりに **ACES は `DepthComposite` の合成パスで掛ける**（`uWorkerExposure`）。
  8bit に落としてから掛けるので、Worker 側で 1.0 を超えるハイライトはクリップする。
- **sRGB テクスチャはサンプル時にハードウェアでリニアに戻る**（three は内部フォーマットを
  `SRGB8_ALPHA8` にする）。合成パスで `sRGBToLinear()` を掛けると二重デコードで暗くなる。
- シーン色（RT）はリニア + トーンマップ前なので、合成パスでレンダラと同じ
  トーンマップ + sRGB エンコードを行う（`uToneMapping` は `renderer.toneMapping` から渡す）。

### その他

- Worker の部屋は `ROOM_LIFT`（6cm）だけ浮かせている。メイン世界の地面も y=0 なので、
  そのままだと床同士が同一平面になり縞（z-fighting）が出る。
- 深度を書かないもの（パーティクル）は深度パスから外している。そのためパーティクルは
  「背後の面の深度」で合成され、手前の遮蔽物に正しく隠れない（仕様として許容）。
- `DepthComposite` の `debug` prop で確認できる:
  `1` 距離 / `2` パックした生バイト / `3` Worker の色のみ / `4` 採用マスク（緑=Worker, 赤=シーン）。

## ステレオ（二視点）と XR

`DepthComposite` は `stereo` prop で 2 視点になる。

- フレームメッセージは `views: ViewMatrices[]`（1 要素 = 単眼、2 要素 = 左右）。
- Worker は **アトラス**（横並び）で描く。キャンバスの横幅は「1 視点ぶん × 視点数」で、
  `setViewport` / `setScissor` で視点ごとに描き分ける（`applyViewCount` で必要時のみ resize）。
- メイン側も同じカメラで RT を左右に分けて 2 回描き、合成シェーダが
  `vUv.x` から視点を選んでアトラスの該当半分を引く。
- モニタ確認用のステレオは「画角そのまま・横半分の解像度」で描く SBS。
  画面の左右に同じ視野が横に縮んで並ぶ（`EYE_OFFSET` で眼間距離を調整できる）。

### ハマりどころ

- **`renderer.setViewport` / `setScissor` は CSS ピクセル指定**。three が内部で
  `pixelRatio` を掛けるので、フレームバッファの実ピクセルを渡すと拡大されて描画が
  ズレる（画面全体が 1.2 倍にズームしたように見えた）。
- RT を分割描画するときは `setScissorTest(true)` も必要（クリアが全画面に及ぶため）。

### XR の制約

WebXR 中のフレームバッファはブラウザが所有し、three が左右の目を自前で描く。
そのため「メインシーンを RT に描いて目ごとに合成する」経路が無く、**深度合成は XR ではできない**。

代わりに XR 中は次の構成にしてある（**実機未検証**）。

- `gl.xr.isPresenting` のときは合成せず `gl.render(scene, camera)` に任せる。
- シーンに左右の目用の板ポリを置き、three の XR の慣習（**layer 1 = 左目 / layer 2 = 右目**）で
  振り分ける。three は `cameraXR.layers.mask = camera.layers.mask | 0b110` として
  目ごとにレイヤーを落とすので、`mesh.layers.set(1)` / `set(2)` で目別に出し分けられる。
- 目ごとのカメラは `gl.xr.getCamera().cameras[0..1]` から取り、その行列を Worker に送る。
- 板ポリはヘッド位置 + 前面 2.4m、2.4m 幅で置く（`XR_SCREEN_DISTANCE` / `XR_SCREEN_WIDTH`）。
  奥行き方向の遮蔽は効かない「ステレオ画面」になる。

## 実装上のクセ

- `ImageBitmap` は使い終わったら `close()` する。メイン側は 1 フレーム遅らせて解放している
  （アップロード前に閉じると壊れるため）。
- `transferToImageBitmap()` は canvas の内容を消費する（呼ぶと空になる）。1 フレームで
  色と深度の 2 枚が欲しいときは「深度を描く → transfer → 色を描く → transfer」の順にする。
- `sRGBTransferEOTF()` で深度パス出力を事前に打ち消している（出力段で sRGB エンコードされるため）。
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
- `DepthComposite`: `stereo`（2 視点）/ `xrScreen`（XR の板ポリ）/ `maxWidth` / `resolutionScale` /
  `maxFps` / `debug`。
  Worker の露出は `uWorkerExposure`（既定 1.15）。`DEPTH_RANGE` は `worker/gpuWorker.ts` と
  揃える必要がある。

## 検証手順

深度合成が壊れたときは、まず `debug` を切り替えて切り分ける。

| 症状 | 見るもの |
| --- | --- |
| 全面がシーン / 全面が Worker | `debug={4}` のマスク |
| 縞・ノイズ状のまだら | `debug={1}` で深度が滑らかか（粗ければパック精度かエンコード） |
| 色が暗い / 白飛び | `debug={3}` で Worker の素の色を確認 |

## 動作確認

```bash
npm run typecheck
npm run dev                     # http://localhost:5173
npm run build && npx vite preview
npx xrift check world           # 23 files APPROVE になること
```

コンソールに `[worker-render] ready: ...` と、120 フレームごとの fps / Worker 描画時間が出る。
