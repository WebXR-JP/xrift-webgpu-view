import type { Matrix4 } from 'three'

export type ViewAnchor = 'center' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

export interface ViewRectOptions {
  /** カメラからの距離（m） */
  distance: number
  /** 画面に対する大きさ（0〜1） */
  coverage: number
  anchor: ViewAnchor
  /** 画面端からの余白（NDC 単位。1 で画面の半分） */
  margin: number
}

export interface FrustumRect {
  /** 視点空間の中心（x, y） */
  x: number
  y: number
  width: number
  height: number
}

function anchorToNdc(anchor: ViewAnchor, coverage: number, margin: number): [number, number] {
  const edge = 1 - coverage - margin
  switch (anchor) {
    case 'top-left':
      return [-edge, edge]
    case 'top-right':
      return [edge, edge]
    case 'bottom-left':
      return [-edge, -edge]
    case 'bottom-right':
      return [edge, -edge]
    default:
      return [0, 0]
  }
}

/**
 * 透視投影の視錐台を、カメラから `distance` の位置で切った矩形を返す。
 *
 * 射影行列から直接求めるので、XR の非対称なフラスタム（左右で fov が違う）でも
 * 画面いっぱいに敷き詰められる。
 */
export function getFrustumRect(
  projection: Matrix4,
  { distance, coverage, anchor, margin }: ViewRectOptions,
): FrustumRect {
  const e = projection.elements

  // 視点空間 z = -distance の断面（NDC の ±1 がどこに来るか）
  const x0 = (distance * (-1 + e[8])) / e[0]
  const x1 = (distance * (1 + e[8])) / e[0]
  const y0 = (distance * (-1 + e[9])) / e[5]
  const y1 = (distance * (1 + e[9])) / e[5]

  const fullWidth = x1 - x0
  const fullHeight = y1 - y0

  const [ndcX, ndcY] = anchorToNdc(anchor, coverage, margin)

  return {
    x: (x0 + x1) / 2 + (ndcX * fullWidth) / 2,
    y: (y0 + y1) / 2 + (ndcY * fullHeight) / 2,
    width: fullWidth * coverage,
    height: fullHeight * coverage,
  }
}
