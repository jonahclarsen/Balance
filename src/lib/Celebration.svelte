<script lang="ts">
  import { onDestroy } from 'svelte'

  let canvas: HTMLCanvasElement
  let banner = false
  let bannerTimer: ReturnType<typeof setTimeout> | undefined
  let raf = 0

  const DAY_MESSAGES = [
    'All done — nice work! ✨',
    'Cleared the board! 🙌',
    'Everything checked off! 🌟',
    'A perfect day! 💫',
  ]
  const LIST_MESSAGES = [
    'Checklist conquered! ✅',
    'That list never stood a chance! 🎉',
    'Nothing left but victory! 🏆',
    'List crushed! ✨',
  ]
  const COLORS = ['#2f6f68', '#79b9ae', '#a5d8cf', '#f4b942', '#ef6f6c', '#8e7dbe']
  let message = DAY_MESSAGES[0]
  let ariaLabel = 'Day finished'

  type Particle = {
    x: number
    y: number
    vx: number
    vy: number
    size: number
    rotation: number
    rotationSpeed: number
    color: string
    life: number
  }

  function reducedMotion() {
    return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  }

  export function celebrate(kind: 'day' | 'list' = 'day') {
    const messages = kind === 'list' ? LIST_MESSAGES : DAY_MESSAGES
    message = messages[Math.floor(Math.random() * messages.length)]
    ariaLabel = kind === 'list' ? 'List finished' : 'Day finished'
    banner = true
    clearTimeout(bannerTimer)
    bannerTimer = setTimeout(() => (banner = false), 2200)

    if (reducedMotion() || !canvas) return
    launchConfetti()
  }

  export function dismiss() {
    banner = false
    clearTimeout(bannerTimer)
    cancelAnimationFrame(raf)
    clearCanvas()
  }

  function clearCanvas() {
    const context = canvas?.getContext('2d')
    if (!context) return
    context.resetTransform()
    context.clearRect(0, 0, canvas.width, canvas.height)
  }

  function launchConfetti() {
    const context = canvas.getContext('2d')
    if (!context) return
    const drawContext: CanvasRenderingContext2D = context

    const dpr = window.devicePixelRatio || 1
    const width = window.innerWidth
    const height = window.innerHeight
    canvas.width = width * dpr
    canvas.height = height * dpr
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
    drawContext.setTransform(dpr, 0, 0, dpr, 0, 0)

    const particles: Particle[] = []
    const bursts = [
      { x: width * 0.2, y: height * 0.4 },
      { x: width * 0.5, y: height * 0.35 },
      { x: width * 0.8, y: height * 0.4 },
    ]

    for (const burst of bursts) {
      for (let index = 0; index < 60; index += 1) {
        const angle = Math.random() * Math.PI * 2
        const speed = 4 + Math.random() * 9
        particles.push({
          x: burst.x,
          y: burst.y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed - 4,
          size: 5 + Math.random() * 7,
          rotation: Math.random() * Math.PI,
          rotationSpeed: (Math.random() - 0.5) * 0.4,
          color: COLORS[Math.floor(Math.random() * COLORS.length)],
          life: 1,
        })
      }
    }

    cancelAnimationFrame(raf)
    const gravity = 0.28
    const drag = 0.985

    function frame() {
      drawContext.clearRect(0, 0, width, height)
      let alive = false

      for (const particle of particles) {
        if (particle.life <= 0) continue
        particle.vx *= drag
        particle.vy = particle.vy * drag + gravity
        particle.x += particle.vx
        particle.y += particle.vy
        particle.rotation += particle.rotationSpeed
        particle.life -= 0.008
        if (particle.y > height + 40) particle.life = 0
        if (particle.life <= 0) continue

        alive = true
        drawContext.save()
        drawContext.globalAlpha = Math.max(0, Math.min(1, particle.life))
        drawContext.translate(particle.x, particle.y)
        drawContext.rotate(particle.rotation)
        drawContext.fillStyle = particle.color
        drawContext.fillRect(-particle.size / 2, -particle.size / 2, particle.size, particle.size * 0.6)
        drawContext.restore()
      }

      if (alive) raf = requestAnimationFrame(frame)
      else drawContext.clearRect(0, 0, width, height)
    }

    frame()
  }

  onDestroy(() => {
    cancelAnimationFrame(raf)
    clearTimeout(bannerTimer)
  })
</script>

<canvas class="celebration-canvas" bind:this={canvas} aria-hidden="true"></canvas>

{#if banner}
  <div class="celebration-banner" role="status" aria-live="polite" aria-atomic="true" aria-label={ariaLabel}>
    {message}
  </div>
{/if}

<style>
  .celebration-canvas {
    position: fixed;
    z-index: 9998;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
  }

  .celebration-banner {
    position: fixed;
    z-index: 9999;
    top: 18%;
    left: 50%;
    border-radius: 999px;
    padding: 0.7rem 1.4rem;
    background: var(--accent, #2f6f68);
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
    color: #fff;
    font-size: 1.15rem;
    font-weight: 700;
    letter-spacing: 0.01em;
    pointer-events: none;
    transform: translateX(-50%);
    animation: celebration-pop 2.2s ease forwards;
  }

  @keyframes celebration-pop {
    0% {
      opacity: 0;
      transform: translateX(-50%) translateY(8px) scale(0.9);
    }

    12% {
      opacity: 1;
      transform: translateX(-50%) translateY(0) scale(1.04);
    }

    22% {
      transform: translateX(-50%) translateY(0) scale(1);
    }

    80% {
      opacity: 1;
    }

    100% {
      opacity: 0;
      transform: translateX(-50%) translateY(-6px) scale(1);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .celebration-banner {
      opacity: 1;
      animation: none;
    }
  }
</style>
