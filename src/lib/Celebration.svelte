<script lang="ts">
  import { onDestroy } from 'svelte'

  let canvas: HTMLCanvasElement
  let banner = false
  let listBurst = false
  let bannerTimer: ReturnType<typeof setTimeout> | undefined
  let listBurstTimer: ReturnType<typeof setTimeout> | undefined
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
  const CHECK_SPARKS = [
    { x: -205, y: -104, delay: 0, hue: 166 },
    { x: -142, y: -168, delay: 35, hue: 43 },
    { x: -55, y: -196, delay: 70, hue: 342 },
    { x: 48, y: -190, delay: 20, hue: 257 },
    { x: 142, y: -154, delay: 85, hue: 19 },
    { x: 210, y: -84, delay: 45, hue: 166 },
    { x: 220, y: 42, delay: 100, hue: 43 },
    { x: 154, y: 132, delay: 60, hue: 342 },
    { x: 54, y: 174, delay: 15, hue: 257 },
    { x: -58, y: 168, delay: 90, hue: 19 },
    { x: -158, y: 120, delay: 50, hue: 166 },
    { x: -220, y: 34, delay: 110, hue: 43 },
  ]
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
    listBurst = false
    clearTimeout(listBurstTimer)
    cancelAnimationFrame(raf)
    clearCanvas()

    if (reducedMotion() || !canvas) return
    if (kind === 'list') {
      listBurst = true
      listBurstTimer = setTimeout(() => (listBurst = false), 1800)
      return
    }
    launchConfetti()
  }

  export function dismiss() {
    banner = false
    listBurst = false
    clearTimeout(bannerTimer)
    clearTimeout(listBurstTimer)
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
    clearTimeout(listBurstTimer)
  })
</script>

<canvas class="celebration-canvas" bind:this={canvas} aria-hidden="true"></canvas>

{#if listBurst}
  <div class="list-celebration" aria-hidden="true">
    <div class="completed-list-card">
      <div class="completed-list-title"><span>✓</span> LIST COMPLETE</div>
      {#each [0, 1, 2] as index}
        <div class="completed-list-row" style={`--row-delay: ${120 + index * 90}ms`}>
          <span>✓</span><i></i>
        </div>
      {/each}
    </div>
    {#each CHECK_SPARKS as spark}
      <span
        class="check-spark"
        style={`--check-x: ${spark.x}px; --check-y: ${spark.y}px; --check-delay: ${spark.delay}ms; --check-hue: ${spark.hue}`}
      >✓</span>
    {/each}
  </div>
{/if}

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

  .list-celebration {
    position: fixed;
    z-index: 9998;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
  }

  .completed-list-card {
    position: absolute;
    top: 50%;
    left: 50%;
    display: grid;
    gap: 9px;
    width: 190px;
    padding: 18px;
    border: 2px solid color-mix(in srgb, var(--accent, #2f6f68) 72%, white);
    border-radius: 14px;
    background: var(--paper-strong, #fff);
    box-shadow: 0 18px 55px rgba(20, 40, 37, 0.28);
    color: var(--accent-strong, #245952);
    animation: completed-list-pop 1.8s cubic-bezier(0.22, 0.8, 0.25, 1) both;
  }

  .completed-list-title {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    font-weight: 800;
    letter-spacing: 0.08em;
  }

  .completed-list-title span {
    display: grid;
    width: 25px;
    height: 25px;
    place-items: center;
    border-radius: 50%;
    background: var(--accent, #2f6f68);
    color: white;
    font-size: 17px;
  }

  .completed-list-row {
    display: flex;
    align-items: center;
    gap: 9px;
    opacity: 0;
    animation: completed-row-check 520ms ease-out var(--row-delay) forwards;
  }

  .completed-list-row span {
    display: grid;
    width: 18px;
    height: 18px;
    place-items: center;
    border-radius: 5px;
    background: color-mix(in srgb, var(--accent, #2f6f68) 18%, transparent);
    font-size: 12px;
    font-weight: 800;
  }

  .completed-list-row i {
    width: 70%;
    height: 6px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--accent, #2f6f68) 22%, var(--line, #ddd));
    transform-origin: left;
  }

  .check-spark {
    position: absolute;
    top: 50%;
    left: 50%;
    display: grid;
    width: 31px;
    height: 31px;
    place-items: center;
    border: 2px solid hsl(var(--check-hue) 64% 52%);
    border-radius: 50%;
    background: hsl(var(--check-hue) 74% 94%);
    box-shadow: 0 5px 14px hsl(var(--check-hue) 55% 35% / 0.2);
    color: hsl(var(--check-hue) 64% 38%);
    font-size: 18px;
    font-weight: 900;
    animation: check-spark-burst 1.35s cubic-bezier(0.16, 0.76, 0.22, 1) var(--check-delay) both;
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

  @keyframes completed-list-pop {
    0% {
      opacity: 0;
      transform: translate(-50%, -42%) rotate(-9deg) scale(0.48);
    }

    18% {
      opacity: 1;
      transform: translate(-50%, -50%) rotate(3deg) scale(1.12);
    }

    31%,
    76% {
      opacity: 1;
      transform: translate(-50%, -50%) rotate(0) scale(1);
    }

    100% {
      opacity: 0;
      transform: translate(-50%, -62%) rotate(2deg) scale(0.94);
    }
  }

  @keyframes completed-row-check {
    from {
      opacity: 0;
      transform: translateX(-12px) scale(0.92);
    }

    to {
      opacity: 1;
      transform: translateX(0) scale(1);
    }
  }

  @keyframes check-spark-burst {
    0% {
      opacity: 0;
      transform: translate(-50%, -50%) rotate(-20deg) scale(0.15);
    }

    18% {
      opacity: 1;
    }

    72% {
      opacity: 1;
      transform: translate(calc(-50% + var(--check-x)), calc(-50% + var(--check-y))) rotate(8deg) scale(1);
    }

    100% {
      opacity: 0;
      transform: translate(calc(-50% + var(--check-x)), calc(-50% + var(--check-y))) rotate(18deg) scale(0.72);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .celebration-banner {
      opacity: 1;
      animation: none;
    }

    .list-celebration {
      display: none;
    }
  }
</style>
