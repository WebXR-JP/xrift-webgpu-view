/**
 * Worker の色 + 深度を、メインシーンの深度と合成してメインキャンバスに描く
 *
 * 仕組み:
 * 1. メインシーンを HDR のレンダーターゲット（色 + DepthTexture）へ描く
 * 2. 全画面クアッドで「シーン色」と「Worker の色」をピクセルごとに選択する
 *    - シーンの深度 → 視点からの距離に変換
 *    - Worker の深度画像（R,G に 16bit でパックされた距離）を復号
 *    - Worker の距離の方が近ければ Worker の色を採用
 * 3. シーン色は RT 由来でリニア + トーンマップ前なので、ここでレンダラと
 *    同じトーンマップ + sRGB エンコードを適用する
 *
 * WebGL2 には gl_FragDepth が無いため、深度を「書く」のではなく
 * 深度を比較して色を選ぶ方式にしている。
 */

import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import {
  ACESFilmicToneMapping,
  DepthTexture,
  HalfFloatType,
  LinearFilter,
  LinearToneMapping,
  Mesh,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  WebGLRenderTarget,
} from 'three'
import { useGpuWorker } from '../../gpu-worker/useGpuWorker'

/** Worker 側の深度パック範囲（worker/gpuWorker.ts の DEPTH_RANGE と合わせる） */
const DEPTH_RANGE = 50

const vertexShader = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

const fragmentShader = /* glsl */ `
precision highp float;

varying vec2 vUv;

uniform sampler2D uSceneColor;
uniform sampler2D uSceneDepth;
uniform sampler2D uWorkerColor;
uniform sampler2D uWorkerDepth;

uniform float uNear;
uniform float uFar;
uniform float uDepthRange;
uniform float uExposure;
uniform float uWorkerExposure;
uniform int uToneMapping;
uniform int uDebug;

// --- three.js の ACESFilmicToneMapping と同じ実装 -------------------------
vec3 RRTAndODTFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}

vec3 acesFilmic(vec3 color) {
  const mat3 ACESInputMat = mat3(
    vec3(0.59719, 0.07600, 0.02840),
    vec3(0.35458, 0.90834, 0.13383),
    vec3(0.04823, 0.01566, 0.83777)
  );
  const mat3 ACESOutputMat = mat3(
    vec3(1.60475, -0.10208, -0.00327),
    vec3(-0.53108, 1.10813, -0.07276),
    vec3(-0.07367, -0.00605, 1.07602)
  );
  color = ACESInputMat * color;
  color = RRTAndODTFit(color);
  color = ACESOutputMat * color;
  return clamp(color, 0.0, 1.0);
}

vec3 linearToSRGB(vec3 color) {
  return mix(
    pow(color, vec3(0.41666)) * 1.055 - 0.055,
    color * 12.92,
    vec3(lessThanEqual(color, vec3(0.0031308)))
  );
}

// R,G に詰めた 16bit 距離を [0,1] に戻す
float unpackDepth(vec2 bytes) {
  float hi = floor(bytes.r * 255.0 + 0.5);
  float lo = floor(bytes.g * 255.0 + 0.5);
  return (hi * 256.0 + lo) / 65535.0;
}

void main() {
  // シーンの深度（window z）→ 視点からの距離
  float depth = texture2D(uSceneDepth, vUv).x;
  float sceneDist = -(uNear * uFar) / ((uFar - uNear) * depth - uFar);

  // Worker 側の距離。Worker の画像は上下反転で入っているので V を反転して引く
  vec2 workerUv = vec2(vUv.x, 1.0 - vUv.y);
  float packedDepth = unpackDepth(texture2D(uWorkerDepth, workerUv).rg);
  float workerDist = packedDepth <= 0.0 ? 1e9 : packedDepth * uDepthRange;

  if (uDebug == 4) {
    // どちらを採用したかのマスク（緑 = Worker / 赤 = シーン）
    bool useWorker = workerDist < sceneDist;
    gl_FragColor = vec4(useWorker ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0), 1.0);
    return;
  }

  if (uDebug == 3) {
    // Worker の色だけを表示（合成の色処理を確認するため）
    gl_FragColor = vec4(texture2D(uWorkerColor, workerUv).rgb, 1.0);
    return;
  }

  if (uDebug == 2) {
    // パックしたバイトをそのまま可視化（R = 上位, G = 下位）
    gl_FragColor = vec4(texture2D(uWorkerDepth, workerUv).rg, 0.0, 1.0);
    return;
  }

  if (uDebug == 1) {
    // 深度パックの確認用
    float t = packedDepth <= 0.0 ? 1.0 : packedDepth;
    gl_FragColor = vec4(vec3(t), 1.0);
    return;
  }

  if (workerDist < sceneDist) {
    // Worker はトーンマップ無しのリニア値を sRGB で出力している。
    // sRGB テクスチャはサンプル時にハードウェアでリニアへ戻るので、
    // ここでは ACES とエンコードだけを行う
    vec3 workerColor = texture2D(uWorkerColor, workerUv).rgb;
    workerColor = acesFilmic(workerColor * (uWorkerExposure / 0.6));
    gl_FragColor = vec4(linearToSRGB(workerColor), 1.0);
    return;
  }

  // シーン色はリニアなので、レンダラと同じ変換をここで行う
  vec3 color = texture2D(uSceneColor, vUv).rgb;
  if (uToneMapping == 4) {
    color = acesFilmic(color * (uExposure / 0.6));
  } else if (uToneMapping == 1) {
    color = clamp(color * uExposure, 0.0, 1.0);
  }
  gl_FragColor = vec4(linearToSRGB(color), 1.0);
}
`

export interface DepthCompositeProps {
  enabled?: boolean
  /** Worker 側の描画解像度の上限（横幅 px） */
  maxWidth?: number
  /** 解像度スケール（devicePixelRatio に掛ける） */
  resolutionScale?: number
  maxFps?: number
  /**
   * デバッグ表示
   * 0: 通常 / 1: パック深度を距離として可視化 / 2: パックした生バイト
   * 3: Worker の色のみ / 4: 採用マスク（緑 = Worker, 赤 = シーン）
   */
  debug?: 0 | 1 | 2 | 3 | 4
}

export const DepthComposite: React.FC<DepthCompositeProps> = ({
  enabled = true,
  maxWidth = 1280,
  resolutionScale = 1,
  maxFps = 60,
  debug = 0,
}) => {
  const gl = useThree((state) => state.gl)
  const scene = useThree((state) => state.scene)
  const camera = useThree((state) => state.camera) as PerspectiveCamera
  const size = useThree((state) => state.size)
  const dpr = useThree((state) => state.viewport.dpr)

  // --- メインシーンを描く HDR ターゲット -----------------------------------
  const target = useMemo(() => {
    const width = Math.max(1, Math.floor(size.width * dpr))
    const height = Math.max(1, Math.floor(size.height * dpr))
    return new WebGLRenderTarget(width, height, {
      type: HalfFloatType,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: true,
      depthTexture: new DepthTexture(width, height),
      stencilBuffer: false,
      samples: 4,
    })
  }, [size.width, size.height, dpr])

  useEffect(() => {
    return () => target.dispose()
  }, [target])

  // --- Worker の解像度 -----------------------------------------------------
  const resolution = useMemo(() => {
    const aspect = size.height / Math.max(1, size.width)
    const width = Math.max(64, Math.min(maxWidth, Math.round(size.width * dpr * resolutionScale)))
    return { width, height: Math.max(1, Math.round(width * aspect)) }
  }, [size.width, size.height, dpr, maxWidth, resolutionScale])

  const { colorTexture, depthTexture, hasFrame } = useGpuWorker({
    width: resolution.width,
    height: resolution.height,
    depth: true,
    maxFps,
    enabled,
  })

  // --- 合成パス ------------------------------------------------------------
  const composite = useMemo(() => {
    const material = new ShaderMaterial({
      uniforms: {
        uSceneColor: { value: null },
        uSceneDepth: { value: null },
        uWorkerColor: { value: null },
        uWorkerDepth: { value: null },
        uNear: { value: 0.1 },
        uFar: { value: 1000 },
        uDepthRange: { value: DEPTH_RANGE },
        uExposure: { value: 1 },
        uWorkerExposure: { value: 1.15 },
        uToneMapping: { value: 0 },
        uDebug: { value: 0 },
      },
      vertexShader,
      fragmentShader,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    })

    const geometry = new PlaneGeometry(2, 2)
    const mesh = new Mesh(geometry, material)
    mesh.frustumCulled = false

    const quadScene = new Scene()
    quadScene.add(mesh)

    return { material, geometry, scene: quadScene, camera: new OrthographicCamera(-1, 1, 1, -1, 0, 1) }
  }, [])

  useEffect(() => {
    return () => {
      composite.geometry.dispose()
      composite.material.dispose()
    }
  }, [composite])

  useFrame(() => {
    if (!enabled) return

    // Worker の出力がまだ無い / XR 中は通常描画にフォールバック
    if (!hasFrame || !depthTexture || gl.xr.isPresenting) {
      gl.render(scene, camera)
      return
    }

    const uniforms = composite.material.uniforms
    uniforms.uSceneColor.value = target.texture
    uniforms.uSceneDepth.value = target.depthTexture
    uniforms.uWorkerColor.value = colorTexture
    uniforms.uWorkerDepth.value = depthTexture
    uniforms.uNear.value = camera.near
    uniforms.uFar.value = camera.far
    uniforms.uExposure.value = gl.toneMappingExposure
    uniforms.uToneMapping.value = gl.toneMapping === ACESFilmicToneMapping ? 4 : gl.toneMapping === LinearToneMapping ? 1 : 0
    uniforms.uDebug.value = debug

    gl.setRenderTarget(target)
    gl.render(scene, camera)
    gl.setRenderTarget(null)
    gl.render(composite.scene, composite.camera)
  }, enabled ? 1 : 0)

  return null
}
