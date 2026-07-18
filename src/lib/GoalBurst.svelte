<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { goalLightnessShift } from './goals'
  import type { Goal } from './types'

  type BurstTarget = { x: number; y: number; onArrive?: () => void }

  let canvas: HTMLCanvasElement
  let raf = 0
  let sized = false

  type Trail = { x: number; y: number }[]

  type Particle = {
    x: number
    y: number
    vx: number
    vy: number
    size: number
    hue: number
    sat: number
    light: number
    life: number
    decay: number
    spin: number
    rotation: number
    twinkle: number
    shape: 'spark' | 'dot' | 'streamer'
    trail: Trail
    trailMax: number
    // When set, this particle is a firework "shell" that detonates into a
    // secondary spray once its life drops below `at`.
    shellAt: number
    detonated: boolean
  }

  type Ring = {
    x: number
    y: number
    radius: number
    maxRadius: number
    life: number
    decay: number
    hue: number
    sat: number
    light: number
    width: number
  }

  type Comet = {
    ox: number
    oy: number
    cx: number
    cy: number
    tx: number
    ty: number
    t: number
    speed: number
    hue: number
    sat: number
    light: number
    trail: Trail
    onArrive?: () => void
    arrived: boolean
  }

  type Label = { id: number; text: string; x: number; y: number; color: string }

  const particles: Particle[] = []
  const rings: Ring[] = []
  const flashes: { x: number; y: number; radius: number; life: number; hue: number; sat: number; light: number }[] = []
  const comets: Comet[] = []
  let labels: Label[] = []
  let labelSeq = 0

  function reducedMotion() {
    return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  }

  function goalColorParts(goal: Goal | undefined) {
    return {
      hue: goal?.hue ?? 165,
      sat: 74,
      light: Math.max(38, Math.min(70, 52 + goalLightnessShift(goal?.lightness))),
    }
  }

  function css({ hue, sat, light }: { hue: number; sat: number; light: number }, alpha = 1) {
    return `hsla(${hue}, ${sat}%, ${light}%, ${alpha})`
  }

  export function burst(x: number, y: number, goals: Goal[], target?: BurstTarget) {
    const base = goalColorParts(goals[0])
    const label = goals.length > 1 ? `✓ ${goals.length} goals` : `✓ ${goals[0]?.name ?? 'Goal'}`
    const id = (labelSeq += 1)
    labels = [...labels, { id, text: label, x, y, color: css(base, 1) }]
    setTimeout(() => {
      labels = labels.filter((entry) => entry.id !== id)
    }, 1600)

    if (reducedMotion() || !canvas) return

    ensureSize()
    spawnBurst(x, y, goals)
    if (target) spawnComet(x, y, target, base)
    startLoop()
  }

  function spawnBurst(x: number, y: number, goals: Goal[]) {
    const palette = goals.length > 0 ? goals.map(goalColorParts) : [goalColorParts(undefined)]
    const pick = () => palette[Math.floor(Math.random() * palette.length)]

    // Impact bloom.
    const bloom = pick()
    flashes.push({ x, y, radius: 46, life: 1, hue: bloom.hue, sat: bloom.sat, light: Math.min(80, bloom.light + 14) })

    // Twin shockwaves.
    const ring = pick()
    rings.push({ x, y, radius: 4, maxRadius: 58, life: 1, decay: 0.045, hue: ring.hue, sat: ring.sat, light: ring.light, width: 3 })
    rings.push({ x, y, radius: 4, maxRadius: 94, life: 1, decay: 0.03, hue: ring.hue, sat: ring.sat, light: ring.light, width: 1.5 })

    const count = 30 + Math.min(goals.length, 3) * 8
    for (let index = 0; index < count; index += 1) {
      const color = pick()
      const angle = Math.random() * Math.PI * 2
      const speed = 2.6 + Math.random() * 7
      const roll = Math.random()
      const shape: Particle['shape'] = roll > 0.86 ? 'streamer' : roll > 0.5 ? 'spark' : 'dot'
      particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 2.6,
        size: shape === 'streamer' ? 3 + Math.random() * 2 : 2.5 + Math.random() * 4,
        hue: color.hue + (Math.random() - 0.5) * 30,
        sat: color.sat + Math.random() * 16,
        light: color.light + Math.random() * 22,
        life: 1,
        decay: shape === 'streamer' ? 0.007 + Math.random() * 0.006 : 0.011 + Math.random() * 0.01,
        spin: (Math.random() - 0.5) * 0.5,
        rotation: Math.random() * Math.PI,
        twinkle: Math.random() * Math.PI * 2,
        shape,
        trail: [],
        trailMax: shape === 'streamer' ? 9 : shape === 'spark' ? 5 : 3,
        // A few sparks are firework shells that split into a second burst.
        shellAt: shape === 'spark' && Math.random() > 0.8 ? 0.55 + Math.random() * 0.15 : -1,
        detonated: false,
      })
    }
  }

  function detonate(parent: Particle) {
    const shards = 7
    for (let index = 0; index < shards; index += 1) {
      const angle = (Math.PI * 2 * index) / shards + Math.random() * 0.4
      const speed = 1.4 + Math.random() * 2.4
      particles.push({
        x: parent.x,
        y: parent.y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        size: 1.6 + Math.random() * 1.8,
        hue: parent.hue + (Math.random() - 0.5) * 24,
        sat: parent.sat,
        light: Math.min(88, parent.light + 12),
        life: 1,
        decay: 0.03 + Math.random() * 0.02,
        spin: 0,
        rotation: 0,
        twinkle: Math.random() * Math.PI * 2,
        shape: 'dot',
        trail: [],
        trailMax: 3,
        shellAt: -1,
        detonated: false,
      })
    }
  }

  function spawnComet(x: number, y: number, target: BurstTarget, base: { hue: number; sat: number; light: number }) {
    // A lobbed arc: control point sits above the midpoint so the spark leaps up
    // and swoops down into the goal cell.
    const midX = (x + target.x) / 2 + (Math.random() - 0.5) * 90
    const midY = Math.min(y, target.y) - 70 - Math.random() * 40
    comets.push({
      ox: x,
      oy: y,
      cx: midX,
      cy: midY,
      tx: target.x,
      ty: target.y,
      t: 0,
      speed: 0.018 + Math.random() * 0.004,
      hue: base.hue,
      sat: base.sat + 12,
      light: Math.min(78, base.light + 16),
      trail: [],
      onArrive: target.onArrive,
      arrived: false,
    })
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
    canvas.getContext('2d')?.setTransform(dpr, 0, 0, dpr, 0, 0)
    sized = true
  }

  function pushTrail(trail: Trail, x: number, y: number, max: number) {
    trail.push({ x, y })
    if (trail.length > max) trail.shift()
  }

  // Soft-glowing dot: a translucent halo behind a bright core. Reads on both
  // light and dark themes without additive blending blowing out.
  function glowDot(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, hsl: { hue: number; sat: number; light: number }, alpha: number) {
    ctx.globalAlpha = alpha * 0.35
    ctx.fillStyle = css({ ...hsl, light: Math.min(92, hsl.light + 12) }, 1)
    ctx.beginPath()
    ctx.arc(x, y, size * 2.4, 0, Math.PI * 2)
    ctx.fill()
    ctx.globalAlpha = alpha
    ctx.fillStyle = css(hsl, 1)
    ctx.beginPath()
    ctx.arc(x, y, size, 0, Math.PI * 2)
    ctx.fill()
  }

  function drawStar(ctx: CanvasRenderingContext2D, radius: number) {
    const spikes = 4
    const inner = radius * 0.38
    ctx.beginPath()
    for (let index = 0; index < spikes * 2; index += 1) {
      const reach = index % 2 === 0 ? radius : inner
      const angle = (Math.PI / spikes) * index - Math.PI / 2
      const px = Math.cos(angle) * reach
      const py = Math.sin(angle) * reach
      if (index === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    }
    ctx.closePath()
    ctx.fill()
  }

  function drawTrail(ctx: CanvasRenderingContext2D, trail: Trail, hsl: { hue: number; sat: number; light: number }, width: number, life: number) {
    if (trail.length < 2) return
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    for (let index = 1; index < trail.length; index += 1) {
      const fade = (index / trail.length) * life
      ctx.globalAlpha = fade * 0.5
      ctx.strokeStyle = css(hsl, 1)
      ctx.lineWidth = width * (index / trail.length)
      ctx.beginPath()
      ctx.moveTo(trail[index - 1].x, trail[index - 1].y)
      ctx.lineTo(trail[index].x, trail[index].y)
      ctx.stroke()
    }
  }

  function startLoop() {
    if (raf) return
    const context = canvas.getContext('2d')
    if (!context) return
    const ctx: CanvasRenderingContext2D = context
    const width = window.innerWidth
    const height = window.innerHeight
    const gravity = 0.15
    const drag = 0.988

    function frame() {
      ctx.clearRect(0, 0, width, height)
      let alive = false

      // Impact blooms.
      for (const flash of flashes) {
        if (flash.life <= 0) continue
        alive = true
        flash.life -= 0.09
        flash.radius += 5
        const gradient = ctx.createRadialGradient(flash.x, flash.y, 0, flash.x, flash.y, flash.radius)
        gradient.addColorStop(0, css(flash, Math.max(0, flash.life) * 0.6))
        gradient.addColorStop(1, css(flash, 0))
        ctx.globalAlpha = 1
        ctx.fillStyle = gradient
        ctx.beginPath()
        ctx.arc(flash.x, flash.y, flash.radius, 0, Math.PI * 2)
        ctx.fill()
      }

      // Shockwaves.
      for (const ring of rings) {
        if (ring.life <= 0) continue
        alive = true
        ring.radius += (ring.maxRadius - ring.radius) * 0.16
        ring.life -= ring.decay
        ctx.globalAlpha = Math.max(0, ring.life) * 0.6
        ctx.strokeStyle = css(ring, 1)
        ctx.lineWidth = ring.width * Math.max(0.2, ring.life)
        ctx.beginPath()
        ctx.arc(ring.x, ring.y, ring.radius, 0, Math.PI * 2)
        ctx.stroke()
      }

      // Firework particles + trails.
      for (const p of particles) {
        if (p.life <= 0) continue
        p.vx *= drag
        p.vy = p.vy * drag + gravity
        p.x += p.vx
        p.y += p.vy
        p.rotation += p.spin
        p.twinkle += 0.32
        p.life -= p.decay
        if (p.y > height + 60) p.life = 0
        pushTrail(p.trail, p.x, p.y, p.trailMax)

        if (!p.detonated && p.shellAt > 0 && p.life <= p.shellAt) {
          p.detonated = true
          detonate(p)
        }
        if (p.life <= 0) continue
        alive = true

        const hsl = { hue: p.hue, sat: p.sat, light: p.light }
        drawTrail(ctx, p.trail, hsl, p.size * 1.4, p.life)

        const twinkle = 0.6 + 0.4 * Math.sin(p.twinkle)
        const alpha = Math.max(0, Math.min(1, p.life)) * twinkle
        if (p.shape === 'spark') {
          ctx.globalAlpha = alpha
          ctx.save()
          ctx.translate(p.x, p.y)
          ctx.rotate(p.rotation)
          ctx.fillStyle = css(hsl, 1)
          drawStar(ctx, p.size)
          ctx.restore()
        } else {
          glowDot(ctx, p.x, p.y, p.size, hsl, alpha)
        }
      }

      // Homing comets → land in the goal cell.
      for (const comet of comets) {
        if (comet.arrived) continue
        alive = true
        comet.t = Math.min(1, comet.t + comet.speed)
        const e = easeInOut(comet.t)
        const inv = 1 - e
        const bx = inv * inv * comet.ox + 2 * inv * e * comet.cx + e * e * comet.tx
        const by = inv * inv * comet.oy + 2 * inv * e * comet.cy + e * e * comet.ty
        pushTrail(comet.trail, bx, by, 16)
        const hsl = { hue: comet.hue, sat: comet.sat, light: comet.light }
        drawTrail(ctx, comet.trail, hsl, 5, 1)
        glowDot(ctx, bx, by, 3.6, hsl, 1)

        if (comet.t >= 1) {
          comet.arrived = true
          landComet(comet)
        }
      }

      ctx.globalAlpha = 1

      prune(particles)
      prune(rings)
      pruneFlashes()
      for (let index = comets.length - 1; index >= 0; index -= 1) {
        if (comets[index].arrived) comets.splice(index, 1)
      }

      if (alive) {
        raf = requestAnimationFrame(frame)
      } else {
        raf = 0
        ctx.clearRect(0, 0, width, height)
      }
    }

    raf = requestAnimationFrame(frame)
  }

  function landComet(comet: Comet) {
    // A crisp little detonation where the spark meets the goal cell.
    const hsl = { hue: comet.hue, sat: comet.sat, light: comet.light }
    flashes.push({ x: comet.tx, y: comet.ty, radius: 20, life: 1, hue: hsl.hue, sat: hsl.sat, light: Math.min(82, hsl.light + 12) })
    rings.push({ x: comet.tx, y: comet.ty, radius: 2, maxRadius: 34, life: 1, decay: 0.06, hue: hsl.hue, sat: hsl.sat, light: hsl.light, width: 2.4 })
    for (let index = 0; index < 12; index += 1) {
      const angle = (Math.PI * 2 * index) / 12 + Math.random() * 0.3
      const speed = 1.6 + Math.random() * 2.2
      particles.push({
        x: comet.tx,
        y: comet.ty,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        size: 1.6 + Math.random() * 1.6,
        hue: hsl.hue + (Math.random() - 0.5) * 20,
        sat: hsl.sat,
        light: Math.min(88, hsl.light + 14),
        life: 1,
        decay: 0.04 + Math.random() * 0.02,
        spin: 0,
        rotation: 0,
        twinkle: Math.random() * Math.PI * 2,
        shape: 'dot',
        trail: [],
        trailMax: 3,
        shellAt: -1,
        detonated: false,
      })
    }
    comet.onArrive?.()
  }

  function easeInOut(t: number) {
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
  }

  function prune(list: { life: number }[]) {
    for (let index = list.length - 1; index >= 0; index -= 1) {
      if (list[index].life <= 0) list.splice(index, 1)
    }
  }

  function pruneFlashes() {
    for (let index = flashes.length - 1; index >= 0; index -= 1) {
      if (flashes[index].life <= 0) flashes.splice(index, 1)
    }
  }

  function handleResize() {
    sized = false
    ensureSize()
  }

  onMount(() => {
    window.addEventListener('resize', handleResize)
  })

  onDestroy(() => {
    cancelAnimationFrame(raf)
    raf = 0
    window.removeEventListener('resize', handleResize)
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
    padding: 0.28rem 0.72rem;
    background: var(--goal-color, #2f6f68);
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.28), 0 0 0 1px color-mix(in srgb, var(--goal-color, #2f6f68) 60%, transparent);
    color: #fff;
    font-size: 0.85rem;
    font-weight: 800;
    letter-spacing: 0.01em;
    white-space: nowrap;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
    pointer-events: none;
    transform: translate(-50%, -50%);
    animation: goal-burst-pop 1.6s cubic-bezier(0.18, 1.4, 0.4, 1) forwards;
  }

  /* A springy overshoot on the way in, a buoyant rise on the way out. */
  @keyframes goal-burst-pop {
    0% {
      opacity: 0;
      transform: translate(-50%, -50%) scale(0.4) rotate(-8deg);
    }

    14% {
      opacity: 1;
      transform: translate(-50%, calc(-50% - 12px)) scale(1.18) rotate(3deg);
    }

    26% {
      transform: translate(-50%, calc(-50% - 16px)) scale(0.96) rotate(-1deg);
    }

    38% {
      transform: translate(-50%, calc(-50% - 18px)) scale(1.04) rotate(0deg);
    }

    70% {
      opacity: 1;
      transform: translate(-50%, calc(-50% - 26px)) scale(1);
    }

    100% {
      opacity: 0;
      transform: translate(-50%, calc(-50% - 58px)) scale(0.96);
    }
  }

  /* The completed row gives a quick springy nudge + goal-colored glow. */
  :global(.goal-row-pop) {
    animation: goal-row-pop 0.55s cubic-bezier(0.2, 1.5, 0.4, 1);
  }

  @keyframes goal-row-pop {
    0% {
      transform: scale(1);
    }
    35% {
      transform: scale(1.02);
      box-shadow: 0 0 0 2px var(--goal-pop-color, rgba(121, 185, 174, 0.6));
    }
    100% {
      transform: scale(1);
    }
  }

  /* The goal's rhythm row flares when the comet lands in it. */
  :global(.goal-rhythm-hit) {
    animation: goal-rhythm-hit 0.7s ease;
  }

  @keyframes goal-rhythm-hit {
    0% {
      filter: none;
    }
    30% {
      filter: brightness(1.35) saturate(1.3);
      transform: scale(1.06);
    }
    100% {
      filter: none;
      transform: scale(1);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .goal-burst-label {
      animation: goal-burst-fade 1.6s ease forwards;
    }

    :global(.goal-row-pop),
    :global(.goal-rhythm-hit) {
      animation: none;
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
