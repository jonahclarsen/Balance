// Extruded blade and handle meshes in millimetres, hinged around the same pin.
type Vertex = [
  number,
  number,
  number
]
type Face = {
  vertices: Vertex[]
  color: string
  arm: number
}
const faces: Face[] = []
function plate(points: number[][], arm: number, z: number, thickness: number, top: string, edge: string) {
  const vertices = (depth: number) => points.map(([x, y]): Vertex => [x, y, depth])
  const upper = vertices(z + thickness), lower = vertices(z)
  faces.push({ vertices: upper, color: top, arm })
  upper.forEach((v, i) => {
    const j = (i + 1) % upper.length
    faces.push({ vertices: [v, upper[j], lower[j], lower[i]], color: edge, arm })
  })
}
for (const arm of [-1, 1]) {
  const z = arm * 1.1
  plate([[-19, -2], [3, -2.3], [37, 0], [3, 2.3], [-19, 2]], arm, z, 1.1, '#c2c9ca', '#5b6467')
  for (let i = 0; i < 24; i++) {
    const ring = (j: number, outer: boolean) => {
      const angle = j * Math.PI / 12
      return [-22 + Math.cos(angle) * (outer ? 12 : 8), arm * 7 + Math.sin(angle) * (outer ? 8 : 4.6)]
    }
    plate([ring(i, true), ring(i + 1, true), ring(i + 1, false), ring(i, false)], arm, z, 2.4, '#405861', '#26383e')
  }
}
plate(Array.from({ length: 14 }, (_, i) => [Math.cos(i * Math.PI / 7) * 2.2, Math.sin(i * Math.PI / 7) * 2.2]), 0, 3, 1, '#ddd6b5', '#77746b')
export function drawScissors(ctx: CanvasRenderingContext2D, x: number, y: number, heading: number, travel: number) {
  const opening = .12 + .13 * (1 + Math.cos(travel / 9))
  const cameraTilt = .30
  const projected = faces.map(face => {
    const a = opening * face.arm
    const points = face.vertices.map(([lx, ly, z]) => {
      const u = lx * Math.cos(a) - ly * Math.sin(a) - 37
      const v = lx * Math.sin(a) + ly * Math.cos(a)
      const dx = u * Math.cos(heading) - v * Math.sin(heading)
      const dy = u * Math.sin(heading) + v * Math.cos(heading)
      const depth = z * Math.cos(cameraTilt) + dy * Math.sin(cameraTilt)
      const perspective = 240 / (240 - depth)
      return [x + dx * perspective, y + (dy * Math.cos(cameraTilt) - z * Math.sin(cameraTilt)) * perspective, depth]
    })
    return { points, color: face.color, depth: points.reduce((sum, p) => sum + p[2], 0) / points.length }
  })
  for (const face of projected.sort((a, b) => a.depth - b.depth)) {
    ctx.beginPath()
    face.points.forEach(([u, v], i) => i ? ctx.lineTo(u, v) : ctx.moveTo(u, v))
    ctx.closePath()
    ctx.fillStyle = face.color
    ctx.fill()
  }
}
