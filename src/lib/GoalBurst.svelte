<script lang="ts">
  import { onDestroy } from 'svelte'
  import { goalLightnessShift } from './goals'
  import type { Goal } from './types'

  let canvas: HTMLCanvasElement
  let raf = 0
  let sized = false

  type Particle = {
    x: number
    y: number
    vx: number
    vy: number
    size: number
    rotation: number
    rotationSpeed: number
    hue: number
    sat: number
    light: number
    twinkle: number
    life: number
    decay: number
  }

  type Ring = {
    x: number
    y: number
    radius: number
    maxRadius: number
    hue: number
    sat: number
    light: number
    life: number
  }

  type Label = {
    id: number
    text: string
    x: number
    y: number
    color: string
  }

  const particles: Particle[] = []
  const rings: Ring[] = []
  let labels: Label[] = []
  let labelSeq = 0

  function reducedMotion() {
    return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  }

  // The designed goal color: a vivid swatch derived from the goal's hue, nudged
  // by its lightness control the same way goal chips elsewhere are shaded.
  function goalColor(goal: Goal | undefined, alpha = 1): string {
    const hue = goal?.hue ?? 165
    const light = Math.max(30, Math.min(80, 54 + goalLightnessShift(goal?.lightness)))
    return `hsla(${hue}, 68%, ${light}%, ${alpha})`
  }

  export function burst(x: number, y: number, goals: Goal[]) {
    const label = goals.length > 1 ? `✓ ${goals.length} goals` : `✓ ${goals[0]?.name ?? 'Goal'}`
    const id = (labelSeq += 1)
    labels = [...labels, { id, text: label, x, y, color: goalColor(goals[0], 1) }]
    setTimeout(() => {
      labels = labels.filter((entry) => entry.id !== id)
    }, 1500)

    if (reducedMotion() || !canvas) return

    ensureSize()
    spawnParticles(x, y, goals)
    rings.push({
      x,
      y,
      radius: 6,
      maxRadius: 46,
      hue: goals[0]?.hue ?? 165,
      sat: 68,
      light: Math.max(30, Math.min(80, 54 + goalLightnessShift(goals[0]?.lightness))),
      life: 1,
    })
    startLoop()
  }

  function spawnParticles(x: number, y: number, goals: Goal[]) {
    const hues = goals.length > 0 ? goals.map((goal) => goal.hue) : [165]
    const count = 26 + Math.min(goals.length, 3) * 6
    for (let index = 0; index < count; index += 1) {
      const angle = Math.random() * Math.PI * 2
      const speed = 2.5 + Math.random() * 6
      const hue = hues[Math.floor(Math.random() * hues.length)] + (Math.random() - 0.5) * 24
      particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 2.4,
        size: 3 + Math.random() * 4.5,
        rotation: Math.random() * Math.PI,
        rotationSpeed: (Math.random() - 0.5) * 0.5,
        hue,
        sat: 70 + Math.random() * 20,
        light: 55 + Math.random() * 25,
        twinkle: Math.random() * Math.PI * 2,
        life: 1,
        decay: 0.012 + Math.random() * 0.01,
      })
    }
  }

  function ensureSize() {
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const width = window.innerWidth
    const height = window.innerHeight
    if (sized && canvas.width === Math.round(width * dpr) && canvas.height === Math.round(height * dpr)) return
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
    const context = canvas.getContext('2d')
    context?.setTransform(dpr, 0, 0, dpr, 0, 0)
    sized = true
  }

  function startLoop() {
    if (raf) return
    const context = canvas.getContext('2d')
    if (!context) return
    const drawContext: CanvasRenderingContext2D = context
    const width = window.innerWidth
    const height = window.innerHeight
    const gravity = 0.16
    const drag = 0.99

    function frame() {
      drawContext.clearRect(0, 0, width, height)
      let alive = false

      for (const ring of rings) {
        if (ring.life <= 0) continue
        alive = true
        ring.radius += (ring.maxRadius - ring.radius) * 0.18
        ring.life -= 0.04
        drawContext.save()
        drawContext.globalAlpha = Math.max(0, ring.life) * 0.7
        drawContext.strokeStyle = `hsl(${ring.hue}, ${ring.sat}%, ${ring.light}%)`
        drawContext.lineWidth = 2.5 * Math.max(0, ring.life)
        drawContext.beginPath()
        drawContext.arc(ring.x, ring.y, ring.radius, 0, Math.PI * 2)
        drawContext.stroke()
        drawContext.restore()
      }

      for (const particle of particles) {
        if (particle.life <= 0) continue
        particle.vx *= drag
        particle.vy = particle.vy * drag + gravity
        particle.x += particle.vx
        particle.y += particle.vy
        particle.rotation += particle.rotationSpeed
        particle.twinkle += 0.3
        particle.life -= particle.decay
        if (particle.y > height + 40) particle.life = 0
        if (particle.life <= 0) continue

        alive = true
        const twinkle = 0.65 + 0.35 * Math.sin(particle.twinkle)
        drawContext.save()
        drawContext.globalAlpha = Math.max(0, Math.min(1, particle.life)) * twinkle
        drawContext.translate(particle.x, particle.y)
        drawContext.rotate(particle.rotation)
        drawContext.fillStyle = `hsl(${particle.hue}, ${particle.sat}%, ${particle.light}%)`
        drawStar(drawContext, particle.size)
        drawContext.restore()
      }

      // Drop fully-dead entries so the arrays don't grow without bound.
      for (let index = particles.length - 1; index >= 0; index -= 1) {
        if (particles[index].life <= 0) particles.splice(index, 1)
      }
      for (let index = rings.length - 1; index >= 0; index -= 1) {
        if (rings[index].life <= 0) rings.splice(index, 1)
      }

      if (alive) {
        raf = requestAnimationFrame(frame)
      } else {
        raf = 0
        drawContext.clearRect(0, 0, width, height)
      }
    }

    raf = requestAnimationFrame(frame)
  }

  // A 4-point sparkle centered on the origin.
  function drawStar(context: CanvasRenderingContext2D, radius: number) {
    const spikes = 4
    const inner = radius * 0.4
    context.beginPath()
    for (let index = 0; index < spikes * 2; index += 1) {
      const reach = index % 2 === 0 ? radius : inner
      const angle = (Math.PI / spikes) * index - Math.PI / 2
      const px = Math.cos(angle) * reach
      const py = Math.sin(angle) * reach
      if (index === 0) context.moveTo(px, py)
      else context.lineTo(px, py)
    }
    context.closePath()
    context.fill()
  }

  onDestroy(() => {
    cancelAnimationFrame(raf)
    raf = 0
  })
</script>

<canvas class="goal-burst-canvas" bind:this={canvas} aria-hidden="true"></canvas>

{#each labels as label (label.id)}
  <div class="goal-burst-label" style={`left: ${label.x}px; top: ${label.y}px; --goal-color: ${label.color}`} role="status" aria-live="polite">
    {label.text}
  </div>
{/each}

<style>
  .goal-burst-canvas {
    position: fixed;
    z-index: 9997;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
  }

  .goal-burst-label {
    position: fixed;
    z-index: 9998;
    border-radius: 999px;
    padding: 0.28rem 0.7rem;
    background: var(--goal-color, #2f6f68);
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.22);
    color: #fff;
    font-size: 0.85rem;
    font-weight: 700;
    letter-spacing: 0.01em;
    white-space: nowrap;
    pointer-events: none;
    transform: translate(-50%, -50%);
    animation: goal-burst-float 1.5s ease-out forwards;
  }

  @keyframes goal-burst-float {
    0% {
      opacity: 0;
      transform: translate(-50%, -50%) scale(0.7);
    }

    18% {
      opacity: 1;
      transform: translate(-50%, calc(-50% - 10px)) scale(1.06);
    }

    30% {
      transform: translate(-50%, calc(-50% - 14px)) scale(1);
    }

    75% {
      opacity: 1;
    }

    100% {
      opacity: 0;
      transform: translate(-50%, calc(-50% - 44px)) scale(1);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .goal-burst-label {
      animation: goal-burst-fade 1.5s ease forwards;
    }

    @keyframes goal-burst-fade {
      0% {
        opacity: 0;
      }

      12% {
        opacity: 1;
      }

      75% {
        opacity: 1;
      }

      100% {
        opacity: 0;
      }
    }
  }
</style>
