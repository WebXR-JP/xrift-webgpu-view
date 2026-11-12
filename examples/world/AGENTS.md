# XRift World Template - AI ガイド

## 詳細な API ドキュメントの取得

詳細な API リファレンス・コードテンプレート・型定義は以下のコマンドで取得できます：

```bash
npx skills add WebXR-JP/xrift-skills
```

---

## 最重要ルール（必ず守ること）

1. **アセット読み込みは必ず `useXRift()` の `baseUrl` を使用**
2. **アセットファイルは `public/` ディレクトリに配置**
3. **`baseUrl` は末尾に `/` を含むため、`${baseUrl}path` で結合**（`${baseUrl}/path` は NG）

```typescript
// ✅ 正しい
const { baseUrl } = useXRift()
const model = useGLTF(`${baseUrl}robot.glb`)

// ❌ 間違い
const model = useGLTF('/robot.glb')           // 絶対パス NG
const model = useGLTF(`${baseUrl}/robot.glb`) // 余分な / NG
```

---

## shared 依存として利用可能なパッケージ

Module Federation により、以下のパッケージはワールドチャンクにインライン化されず shared チャンクとして分離されます：

- `react`, `react-dom`, `react/jsx-runtime`, `react-dom/client`
- `three`
- `three/addons/loaders/GLTFLoader.js`, `three/addons/loaders/DRACOLoader.js`, `three/addons/loaders/KTX2Loader.js`（サブパス単位のみ。バレル全体やその他のアドオンは対象外）
- `@react-three/fiber`, `@react-three/drei`, `@react-three/rapier`
- `@react-three/uikit`, `@pmndrs/uikit`
- `@xrift/world-components`

**Three.js アドオンについて**: DRACOLoader 等の Three.js アドオンは `three/addons/loaders/xxx.js` のサブパスで import してください（`three/addons` バレル全体は shared 対象外）。`three/examples/jsm` からの直接 import はワールドチャンクにインライン化され、`@xrift/code-security` で `new Worker()` が critical 違反として検出される場合があります。

```typescript
// ✅ 正しい（shared チャンクとして分離される）
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'

// ❌ 間違い（インライン化されセキュリティ違反の可能性）
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
```

---

## プロジェクト概要

このディレクトリは **`@webxr-jp/webgpu-view` の動作確認用ワールド**（テスト用）。
ライブラリ本体はリポジトリ直下（`../../src`）にあり、ここはパッケージには含めない。

- **用途**: ライブラリの動作確認（モニタ / XR）と XRift へのアップロード検証
- **技術**: React Three Fiber + Rapier物理エンジン + Module Federation
- **動作**: CDNにアップロード後、フロントエンドから動的ロード

---

## プロジェクト構造

```
xrift-webgpu-view/            # リポジトリ = npm パッケージ
├── src/                      # ★ ライブラリ本体（@webxr-jp/webgpu-view）
├── vite.config.ts            # ライブラリビルド（3 エントリ）
├── package.json              # @webxr-jp/webgpu-view
└── examples/
    └── world/                # ★ このディレクトリ（テスト用ワールド）
        ├── public/           # アセットファイル（直接配置、サブディレクトリ不要）
        ├── src/
        │   ├── components/   # 3Dコンポーネント
        │   ├── World.tsx     # メインワールドコンポーネント
        │   ├── dev.tsx       # 開発用エントリーポイント
        │   ├── index.tsx     # 本番用エクスポート
        │   ├── constants.ts  # 定数定義
        │   └── worker/       # Worker エントリ + WebGPU シーン
        ├── .triplex/         # Triplex（3Dエディタ）設定
        ├── xrift.json        # XRift CLI設定
        ├── vite.config.ts    # ビルド設定（Module Federation）
        └── package.json      # @webxr-jp/webgpu-view-example（private）
```

---

## コマンドリファレンス

```bash
# リポジトリ直下から
npm run example:dev    # ライブラリをビルドして開発サーバー起動 (https://localhost:5173)
npm run example:build  # ワールドの本番ビルド
npm run check          # 本体 + ワールドの型チェックとビルド

# examples/world 内で（predev / prebuild がライブラリを自動ビルドする）
npm run dev        # 開発サーバー起動 (https://localhost:5173)
npm run dev -- --host  # LAN の実機（iPad など）から開く
npm run build      # 本番ビルド
npm run typecheck  # 型チェック

# XRift CLI（examples/world で実行）
xrift login        # 認証
xrift create world # 新規ワールドプロジェクト作成
xrift upload       # アップロード（xrift.json から自動判定）
xrift whoami       # ログインユーザー確認
xrift logout       # ログアウト
```

---

## 実機（iPad / スマホ）で開く

dev サーバーは `@vitejs/plugin-basic-ssl` で HTTPS 配信する（WebGPU は secure context 必須）。

```bash
npm run dev -- --host        # https://192.168.x.x:5173/
```

- **iPad は iPadOS 26 以降でないと WebGPU が無い**。`navigator.gpu` が無いと Worker が fatal error を返し、
  `GpuBackdrop` は `visible=false` のまま（コンソールにしか出ない）。画面は Skybox + 静止したシーンになる。
- 証明書は自己署名（`localhost` / ループバックのみ SAN）なので、実機では警告を一度許可する。
  `?debug=1` を付けると `[webgpu-view] ready: ...` と fps がコンソールに出る。
- `?debug=1` で画面左上に HUD が出る（`src/components/DebugHud`・開発サーバー専用）。
  `main` が rAF の実測、`worker` が Worker から返ってきたフレーム数、`stats` は最後の計測からの経過。
  タブごと固まったのか / Worker だけ止まったのかを実機の画面だけで切り分けられる。
  Worker の区間計測も見るなら `?debug=1&profile=1`。
- 受け渡し経路は `?transfer=buffer|bitmap` で上書きできる（未指定は自動判定）。HUD の右端に実際の経路が出る。
- `DevEnvironment` はマウス・キーボード前提（タッチの視点操作は無い）。iPad で操作するなら
  外付けのマウス / キーボードを使うか、`xrift upload` したものを XRift 上で開く。

---

## 実装例の参照先

このテンプレートは最小構成のため、実装例は以下のみです。その他のコンポーネント（VideoPlayer、Interactable等）の使い方は [XRift ドキュメント](https://docs.xrift.net) を参照してください。

- **Skybox**: `src/components/Skybox/index.tsx`
- **メインワールド**: `src/World.tsx`
