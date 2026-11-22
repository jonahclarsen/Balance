// A hinged pair of shears, in millimetre-like model units. Each handle is an
// elliptical tube with a flattened grip; steel blades have a distinct bevel.
// The camera projects each vertex, then the faces are painted back to front.
type Vec = [number, number, number]
type Face = { points: Vec[]; material: [number, number, number]; arm: number }
const faces: Face[] = []
const steel: Face['material'] = [182, 192, 193],
  bevel: Face['material'] = [230, 236, 235],
  handle: Face['material'] = [41, 103, 99]

function solid(shape: [number, number][], base: number, depth: number, color: Face['material'], arm: number) {
  const ring = (z: number): Vec[] => shape.map(([x, y]) => [x, y, z])
  const lower = ring(base),
    upper = ring(base + depth)
  faces.push({ points: upper, material: color, arm })
  upper.forEach((p, i) => {
    const j = (i + 1) % upper.length
    faces.push({ points: [p, lower[i], lower[j], upper[j]], material: color, arm })
  })
}
for (const side of [-1, 1]) {
  const z = side === 1 ? 2 : 0
  solid(
    [
      [-31, side * 13],
      [-25, side * 6],
      [-6, side * -2],
      [4, side * -3],
      [53, side * 0.9],
      [56, side * 2.1],
      [18, side * 6],
      [2, side * 6],
    ],
    z,
    1.6,
    steel,
    side,
  )
  faces.push({
    points: [
      [1, side * 3, z + 1.7],
      [56, side * 2.1, z + 1.7],
      [53, side * 0.9, z + 1.7],
      [3, -side * 2, z + 1.7],
    ],
    material: bevel,
    arm: side,
  })
  solid(
    [
      [-38, side * 15],
      [-35, side * 6],
      [-20, side * 5],
      [-12, side * 1],
      [-11, side * 3],
      [-22, side * 12],
    ],
    z,
    4,
    handle,
    side,
  )
  const sections = 36,
    around = 8,
    rx = side === 1 ? 21 : 16,
    ry = side === 1 ? 10.5 : 9.5
  const vertex = (i: number, j: number): Vec => {
    const a = (2 * Math.PI * i) / sections,
      b = (2 * Math.PI * j) / around
    const x = (rx + 3.9 * Math.cos(b)) * Math.cos(a),
      y = (ry + 3.9 * Math.cos(b)) * Math.sin(a)
    return [-35 + x, side * (15 + y - x * 0.23), z + 3 + 3.1 * Math.sin(b)]
  }
  for (let i = 0; i < sections; i++)
    for (let j = 0; j < around; j++)
      faces.push({
        points: [vertex(i, j), vertex(i + 1, j), vertex(i + 1, j + 1), vertex(i, j + 1)],
        material: handle,
        arm: side,
      })
}
const cap: [number, number][] = Array.from({ length: 18 }, (_, i) => [
  4.1 * Math.cos((i * Math.PI) / 9),
  4.1 * Math.sin((i * Math.PI) / 9),
])
solid(cap, 4, 2.8, [208, 192, 150], 0)
solid(
  [
    [-2.3, -0.55],
    [2.3, -0.55],
    [2.3, 0.55],
    [-2.3, 0.55],
  ],
  6.8,
  0.15,
  [89, 93, 89],
  0,
)

export function drawScissors(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  direction: number,
  opening: number,
  scale: number,
) {
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(direction)
  ctx.scale(scale, scale)
  ctx.translate(-54, 0)
  const projected = faces
    .map((face) => {
      const a = face.arm * opening,
        c = Math.cos(a),
        s = Math.sin(a)
      const points = face.points.map(([x, y, z]): Vec => {
        const px = x * c - y * s,
          py = x * s + y * c
        const lift = z + Math.max(0, -px) * 0.115
        return [px, py * 0.91 - lift * 0.58, lift + py * 0.05]
      })
      const [p, q, r] = points
      const ax = q[0] - p[0],
        ay = q[1] - p[1],
        az = q[2] - p[2],
        bx = r[0] - p[0],
        by = r[1] - p[1],
        bz = r[2] - p[2]
      const nx = ay * bz - az * by,
        ny = az * bx - ax * bz,
        nz = ax * by - ay * bx
      const shade =
        0.7 + (0.38 * (-nx * 0.36 - ny * 0.55 + Math.abs(nz) * 0.75)) / (Math.hypot(nx, ny, nz) || 1)
      return {
        points,
        depth: points.reduce((v, p) => v + p[2], 0) / points.length,
        color: 'rgb(' + face.material.map((v) => Math.min(255, Math.round(v * shade))).join(',') + ')',
      }
    })
    .sort((a, b) => a.depth - b.depth)
  for (const { points, color } of projected) {
    ctx.beginPath()
    ctx.moveTo(points[0][0], points[0][1])
    for (const p of points.slice(1)) ctx.lineTo(p[0], p[1])
    ctx.closePath()
    ctx.fillStyle = color
    ctx.fill()
    ctx.strokeStyle = color
    ctx.lineWidth = 0.35
    ctx.stroke()
  }
  ctx.restore()
}
