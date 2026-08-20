<script lang="ts" context="module">
  import type { CompletionCelebrationId } from './celebrations'

  export type CelebrationPlayRequest =
    | { kind: 'day'; celebrationId: CompletionCelebrationId; preview?: boolean; seed?: number }
    | { kind: 'list' }
</script>

<script lang="ts">
  import { onDestroy } from 'svelte'
  import { isTauri } from '@tauri-apps/api/core'
  import { vibrate } from '@tauri-apps/plugin-haptics'
  import {
    DEFAULT_COMPLETION_CELEBRATION_ID,
    getCompletionCelebration,
  } from './celebrations'

  type CelebrationDefinition = ReturnType<typeof getCompletionCelebration>
  type Piece = { className: string; text?: string; style: string }

  let canvas: HTMLCanvasElement
  let banner = false
  let listBurst = false
  let activeDefinition: CelebrationDefinition | null = null
  let pieces: Piece[] = []
  let message = 'All done — nice work! ✨'
  let ariaLabel = 'Day finished'
  let reduced = false
  let preview = false
  let runToken = 0
  let raf = 0
  let controller: AbortController | null = null
  let animations: Animation[] = []
  let timers = new Set<number>()
  let resizeCleanup: (() => void) | null = null
  let visibilityCleanup: (() => void) | null = null

  const LIST_MESSAGES = [
    'Checklist conquered! ✅',
    'That list never stood a chance! 🎉',
    'Nothing left but victory! 🏆',
    'List crushed! ✨',
  ]
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

  function prefersReducedMotion() {
    return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  }

  function later(callback: () => void, delay: number) {
    const id = window.setTimeout(() => {
      timers.delete(id)
      callback()
    }, delay)
    timers.add(id)
    return id
  }

  function seededRandom(seed: number) {
    let value = seed >>> 0
    return () => {
      value += 0x6d2b79f5
      let result = value
      result = Math.imul(result ^ (result >>> 15), result | 1)
      result ^= result + Math.imul(result ^ (result >>> 7), result | 61)
      return ((result ^ (result >>> 14)) >>> 0) / 4294967296
    }
  }

  function randomSeed(id: string) {
    let seed = 2166136261
    for (let index = 0; index < id.length; index += 1) {
      seed ^= id.charCodeAt(index)
      seed = Math.imul(seed, 16777619)
    }
    if (globalThis.crypto?.getRandomValues) {
      const random = new Uint32Array(1)
      globalThis.crypto.getRandomValues(random)
      seed ^= random[0]
    } else {
      seed ^= Math.floor(Math.random() * 0xffffffff)
    }
    return seed >>> 0
  }

  function makePieces(definition: CelebrationDefinition, random: () => number): Piece[] {
    const recipe = definition.recipe
    if (recipe === 'dandelion') {
      return Array.from({ length: 24 }, (_, index) => ({
        className: 'dandelion-seed', text: index % 5 === 0 ? '✓' : '•',
        style: `--x:${8 + random() * 84}vw;--drift:${-90 + random() * 180}px;--delay:${random() * 1.2}s;--scale:${0.7 + random() * 0.8}`,
      }))
    }
    if (recipe === 'fireflies') {
      return Array.from({ length: 18 }, (_, index) => ({
        className: 'firefly', text: index % 6 === 0 ? '✓' : '',
        style: `--x:${24 + random() * 52}vw;--y:${28 + random() * 52}vh;--dx:${-38 + random() * 76}px;--dy:${-35 + random() * 70}px;--delay:${random() * 1.4}s`,
      }))
    }
    if (recipe === 'stained-glass') {
      return Array.from({ length: 18 }, (_, index) => ({
        className: 'glass-pane', text: index % 7 === 0 ? '✓' : '',
        style: `--x:${(index % 6) * 17 - 1}vw;--y:${Math.floor(index / 6) * 34 - 1}vh;--r:${-8 + random() * 16}deg;--delay:${random() * 0.45}s;--color:${definition.palette[index % 3]}`,
      }))
    }
    if (recipe === 'papel-picado') {
      return Array.from({ length: 9 }, (_, index) => ({
        className: 'papel-flag', text: ['✓', '✿', '☀', '✦'][index % 4],
        style: `--x:${index * 12 - 2}vw;--delay:${index * 0.07}s;--color:${definition.palette[index % 3]}`,
      }))
    }
    if (recipe === 'tile-garden') {
      return Array.from({ length: 48 }, (_, index) => ({
        className: 'garden-tile', text: index % 2 ? '✦' : '✚',
        style: `--x:${(index % 8) * 12.5 + 1}vw;--y:${Math.floor(index / 8) * 17 + 2}vh;--delay:${Math.abs((index % 8) - 3.5) * 0.06 + Math.abs(Math.floor(index / 8) - 2.5) * 0.06}s;--color:${definition.palette[index % 3]}`,
      }))
    }
    if (recipe === 'chorus') {
      return Array.from({ length: 10 }, (_, index) => ({
        className: 'chorus-check', text: '✓',
        style: `--x:${8 + index * 9}vw;--delay:${index * 0.09}s;--color:${definition.palette[index % 3]}`,
      }))
    }
    if (recipe === 'approved') {
      return ['FORM 100-DONE', 'NO TASKS OUTSTANDING', 'SUSPICIOUSLY COMPLETE'].map((text, index) => ({
        className: 'bureau-seal', text,
        style: `--x:${12 + index * 26}vw;--y:${61 + (index % 2) * 10}vh;--delay:${0.35 + index * 0.16}s;--r:${-9 + index * 10}deg`,
      }))
    }
    if (recipe === 'janitor') {
      return Array.from({ length: 16 }, (_, index) => ({
        className: 'dust', text: index % 3 === 0 ? '×' : '·',
        style: `--x:${18 + random() * 66}vw;--delay:${random() * 1.3}s;--size:${0.7 + random()}`,
      }))
    }
    if (recipe === 'zero-gravity') {
      return Array.from({ length: 12 }, (_, index) => ({
        className: 'orbit-card', text: index % 3 === 0 ? '✓' : '',
        style: `--angle:${index * 30}deg;--radius:${80 + (index % 3) * 42}px;--delay:${index * -0.12}s;--color:${definition.palette[index % 3]}`,
      }))
    }
    if (recipe === 'mitosis') {
      return Array.from({ length: 4 }, (_, index) => ({
        className: 'baby-ui', text: `☰  ✓\n—  ✓`,
        style: `--angle:${index * 90 + 45}deg;--color:${definition.palette[index % 3]};--delay:${index * 0.12}s`,
      }))
    }
    return []
  }

  function clearCanvas() {
    const context = canvas?.getContext('2d')
    if (!context) return
    context.resetTransform?.()
    context.clearRect(0, 0, canvas.width, canvas.height)
  }

  function cleanup(resetPresentation = true) {
    runToken += 1
    controller?.abort()
    controller = null
    cancelAnimationFrame(raf)
    raf = 0
    for (const timer of timers) window.clearTimeout(timer)
    timers.clear()
    for (const animation of animations) animation.cancel()
    animations = []
    resizeCleanup?.()
    visibilityCleanup?.()
    resizeCleanup = null
    visibilityCleanup = null
    clearCanvas()
    if (typeof document !== 'undefined') delete document.documentElement.dataset.celebrationId
    pieces = []
    activeDefinition = null
    preview = false
    if (resetPresentation) {
      banner = false
      listBurst = false
    }
  }

  export function dismiss() {
    cleanup(true)
  }

  /** Backward-compatible bridge while callers migrate to the request API. */
  export function celebrate(kind: 'day' | 'list' = 'day') {
    if (kind === 'list') play({ kind: 'list' })
    else play({ kind: 'day', celebrationId: DEFAULT_COMPLETION_CELEBRATION_ID })
  }

  export function play(request: CelebrationPlayRequest) {
    cleanup(true)
    const token = runToken
    controller = new AbortController()
    reduced = prefersReducedMotion()

    if (request.kind === 'list') {
      message = LIST_MESSAGES[Math.floor(Math.random() * LIST_MESSAGES.length)]
      ariaLabel = 'List finished'
      banner = true
      later(() => { if (token === runToken) banner = false }, 2200)
      if (!reduced) {
        listBurst = true
        later(() => { if (token === runToken) listBurst = false }, 1800)
      }
      return
    }

    const definition = getCompletionCelebration(request.celebrationId)
    const random = seededRandom(request.seed ?? randomSeed(definition.id))
    activeDefinition = definition
    preview = Boolean(request.preview)
    pieces = makePieces(definition, random)
    message = `${definition.icon} ${definition.name} — day complete!`
    ariaLabel = 'Day finished'
    banner = true
    document.documentElement.dataset.celebrationId = definition.id
    later(() => { if (token === runToken) banner = false }, reduced ? 2000 : 2200)
    later(() => { if (token === runToken) cleanup(true) }, Math.min(6000, definition.durationMs + 500))

    if (reduced) return
    animateInterface(definition.recipe)
    if (definition.recipe === 'applause') void requestApplauseHaptic()
    launchCanvas(definition, random, token)
  }

  async function requestApplauseHaptic() {
    if (!isTauri() || !/Android|iPhone|iPad/i.test(navigator.userAgent)) return
    try {
      await vibrate(42)
    } catch {
      navigator.vibrate?.(42)
    }
  }

  function addAnimation(element: Element | null, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
    if (!(element instanceof HTMLElement) || typeof element.animate !== 'function') return
    const animation = element.animate(keyframes, options)
    animations.push(animation)
  }

  function animateInterface(recipe: string) {
    const shell = document.querySelector('.app-shell')
    const pane = document.querySelector('.day-pane')
    const sidebar = document.querySelector('.sidebar')
    const rows = Array.from(document.querySelectorAll('.day-pane .plan-row')).slice(0, 18)

    if (recipe === 'domino') {
      rows.forEach((row, index) => addAnimation(row, [
        { transform: 'perspective(700px) rotateX(0deg)' },
        { transform: 'perspective(700px) rotateX(67deg)', offset: 0.42 },
        { transform: 'perspective(700px) rotateX(0deg)' },
      ], { duration: 1500, delay: index * 75, easing: 'cubic-bezier(.3,.8,.25,1)' }))
    } else if (recipe === 'zero-gravity') {
      addAnimation(pane, [
        { transform: 'translateY(0) rotate(0)' },
        { transform: 'translateY(-22px) rotate(.7deg)', offset: 0.48 },
        { transform: 'translateY(0) rotate(0)' },
      ], { duration: 3900, easing: 'ease-in-out' })
      addAnimation(sidebar, [
        { transform: 'translateX(0)' }, { transform: 'translateX(-7px)', offset: 0.5 }, { transform: 'translateX(0)' },
      ], { duration: 3600, easing: 'ease-in-out' })
    } else if (recipe === 'curtain') {
      rows.forEach((row, index) => addAnimation(row, [
        { transform: 'perspective(500px) rotateX(0deg)' },
        { transform: 'perspective(500px) rotateX(15deg) translateY(5px)', offset: 0.5 },
        { transform: 'perspective(500px) rotateX(0deg)' },
      ], { duration: 1900, delay: 700 + index * 35, easing: 'ease-in-out' }))
    } else if (recipe === 'inhale') {
      addAnimation(shell, [
        { transform: 'scale(1)', filter: 'saturate(1)' },
        { transform: 'scale(.985)', filter: 'saturate(1.18)', offset: 0.42 },
        { transform: 'scale(1.008)', filter: 'saturate(1.05)', offset: 0.78 },
        { transform: 'scale(1)', filter: 'saturate(1)' },
      ], { duration: 3200, easing: 'ease-in-out' })
    } else if (recipe === 'chromatic-echo') {
      addAnimation(shell, [
        { transform: 'translateX(0)', filter: 'none' },
        { transform: 'translateX(-4px)', filter: 'drop-shadow(8px 0 #ff2851) drop-shadow(-8px 0 #287cff)', offset: 0.35 },
        { transform: 'translateX(3px)', filter: 'drop-shadow(-6px 0 #22e39f) drop-shadow(6px 0 #ff2851)', offset: 0.7 },
        { transform: 'translateX(0)', filter: 'none' },
      ], { duration: 2400, easing: 'cubic-bezier(.2,.8,.2,1)' })
    } else if (recipe === 'applause') {
      addAnimation(pane, [
        { transform: 'perspective(700px) rotateX(0deg)' },
        { transform: 'perspective(700px) rotateX(7deg) translateY(7px)', offset: 0.43 },
        { transform: 'perspective(700px) rotateX(0deg)' },
      ], { duration: 2200, easing: 'ease-in-out' })
    }
  }

  function launchCanvas(definition: CelebrationDefinition, random: () => number, token: number) {
    const context = canvas?.getContext('2d')
    if (!context) return
    const draw = context
    let width = 1
    let height = 1
    let dpr = 1
    let started = performance.now()

    function resize() {
      width = Math.max(1, window.innerWidth)
      height = Math.max(1, window.innerHeight)
      dpr = Math.min(2, window.devicePixelRatio || 1)
      const requestedPixels = width * height * dpr * dpr
      if (requestedPixels > 4_000_000) dpr *= Math.sqrt(4_000_000 / requestedPixels)
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      draw.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    resize()
    const canvasRecipes = new Set([
      'constellation', 'bioluminescence', 'woodblock-wave', 'kaleidoscope',
      'reaction-bloom', 'feedback-tunnel', 'event-horizon',
    ])
    if (!canvasRecipes.has(definition.recipe)) return

    const points = Array.from({ length: width < 600 ? 110 : 220 }, () => ({
      x: random(), y: random(), size: 1.5 + random() * 5, phase: random() * Math.PI * 2,
    }))

    function frame(now: number) {
      if (token !== runToken || controller?.signal.aborted || document.hidden) return
      const elapsed = now - started
      const progress = Math.min(1, elapsed / definition.durationMs)
      draw.setTransform(dpr, 0, 0, dpr, 0, 0)
      draw.clearRect(0, 0, width, height)
      draw.save()
      draw.globalAlpha = Math.sin(progress * Math.PI) ** 0.55
      drawRecipe(draw, definition.recipe, definition.palette, width, height, elapsed / 1000, progress, points)
      draw.restore()
      if (progress < 1) raf = requestAnimationFrame(frame)
      else clearCanvas()
    }

    started = performance.now()
    raf = requestAnimationFrame(frame)
    let resizeRaf = 0
    const onResize = () => {
      cancelAnimationFrame(resizeRaf)
      resizeRaf = requestAnimationFrame(resize)
    }
    window.addEventListener('resize', onResize)
    resizeCleanup = () => {
      cancelAnimationFrame(resizeRaf)
      window.removeEventListener('resize', onResize)
    }
    const onVisibility = () => {
      if (!document.hidden && token === runToken) raf = requestAnimationFrame(frame)
    }
    document.addEventListener('visibilitychange', onVisibility)
    visibilityCleanup = () => document.removeEventListener('visibilitychange', onVisibility)
  }

  function drawRecipe(
    draw: CanvasRenderingContext2D,
    recipe: string,
    palette: readonly [string, string, string],
    width: number,
    height: number,
    time: number,
    progress: number,
    points: Array<{ x: number; y: number; size: number; phase: number }>,
  ) {
    if (recipe === 'constellation') {
      const stars = points.slice(0, 18).map((point, index) => ({
        x: width * (0.18 + point.x * 0.64), y: height * (0.25 + ((point.y + index * 0.09) % 1) * 0.48),
      }))
      draw.strokeStyle = palette[0]
      draw.lineWidth = 1.5
      draw.beginPath()
      stars.forEach((star, index) => index ? draw.lineTo(star.x, star.y) : draw.moveTo(star.x, star.y))
      draw.stroke()
      for (const star of stars) {
        draw.fillStyle = palette[1]
        draw.beginPath(); draw.arc(star.x, star.y, 2.5 + Math.sin(time * 3 + star.x) * 1.2, 0, Math.PI * 2); draw.fill()
      }
      return
    }
    if (recipe === 'bioluminescence') {
      const waterline = height * (0.67 - progress * 0.08)
      draw.fillStyle = 'rgba(4, 18, 62, .55)'
      draw.beginPath(); draw.moveTo(0, waterline)
      for (let x = 0; x <= width; x += 18) draw.lineTo(x, waterline + Math.sin(x * 0.018 + time * 2) * 22)
      draw.lineTo(width, height); draw.lineTo(0, height); draw.fill()
      draw.globalCompositeOperation = 'lighter'
      points.slice(0, 90).forEach((point) => {
        const x = point.x * width
        const y = waterline + point.y * Math.max(1, height - waterline)
        draw.fillStyle = palette[Math.floor(point.phase) % 3]
        draw.globalAlpha = .2 + .7 * Math.abs(Math.sin(time * 2 + point.phase))
        draw.beginPath(); draw.arc(x, y, point.size, 0, Math.PI * 2); draw.fill()
      })
      return
    }
    if (recipe === 'woodblock-wave') {
      const base = height * .72
      palette.forEach((color, layer) => {
        draw.fillStyle = color
        draw.beginPath(); draw.moveTo(0, height)
        for (let x = 0; x <= width; x += 12) {
          const crest = Math.sin(x * .014 - time * (1.4 - layer * .18) + layer) * (44 + layer * 14)
          const curl = Math.sin(x * .031 + time + layer) * 12
          draw.lineTo(x, base + layer * 35 + crest + curl)
        }
        draw.lineTo(width, height); draw.fill()
      })
      draw.fillStyle = '#fff'
      points.slice(0, 30).forEach((point, index) => draw.fillText(index % 4 ? '·' : '✓', point.x * width, base - point.y * 100))
      return
    }
    if (recipe === 'kaleidoscope') {
      const cx = width / 2, cy = height / 2
      for (let wedge = 0; wedge < 12; wedge += 1) {
        draw.save(); draw.translate(cx, cy); draw.rotate(wedge * Math.PI / 6 + time * .18)
        if (wedge % 2) draw.scale(-1, 1)
        for (let ring = 0; ring < 7; ring += 1) {
          draw.fillStyle = palette[(wedge + ring) % 3]
          draw.beginPath()
          draw.moveTo(8 + ring * 20, 0)
          draw.lineTo(24 + ring * 26, 9 + ring * 5)
          draw.lineTo(18 + ring * 22, 31 + ring * 14)
          draw.closePath(); draw.fill()
        }
        draw.restore()
      }
      draw.fillStyle = '#fff'; draw.font = 'bold 54px system-ui'; draw.textAlign = 'center'; draw.fillText('✓', cx, cy + 18)
      return
    }
    if (recipe === 'reaction-bloom') {
      draw.globalCompositeOperation = 'lighter'
      points.slice(0, width < 600 ? 100 : 180).forEach((point, index) => {
        const radius = point.size * (3 + 5 * Math.sin(progress * Math.PI))
        draw.strokeStyle = palette[index % 3]
        draw.lineWidth = 2 + (index % 3)
        draw.beginPath()
        draw.arc(
          point.x * width,
          point.y * height,
          Math.max(0.1, radius + Math.sin(time * 2 + point.phase) * 5),
          0,
          Math.PI * 2,
        )
        draw.stroke()
      })
      return
    }
    if (recipe === 'feedback-tunnel') {
      draw.fillStyle = 'rgba(4, 2, 18, .74)'; draw.fillRect(0, 0, width, height)
      draw.translate(width / 2, height / 2)
      for (let index = 22; index >= 0; index -= 1) {
        const phase = (index / 22 + time * .22) % 1
        const scale = .04 + phase * 1.15
        draw.save(); draw.rotate(index * .085 + time * .08)
        draw.strokeStyle = palette[index % 3]; draw.lineWidth = 2 + (1 - phase) * 5
        draw.strokeRect(-width * .34 * scale, -height * .32 * scale, width * .68 * scale, height * .64 * scale)
        draw.restore()
      }
      draw.fillStyle = '#fff'; draw.font = 'bold 58px system-ui'; draw.textAlign = 'center'; draw.fillText('✓', 0, 20)
      return
    }
    if (recipe === 'event-horizon') {
      const cx = width / 2, cy = height / 2
      const gradient = draw.createRadialGradient(cx, cy, 12, cx, cy, Math.min(width, height) * .26)
      gradient.addColorStop(0, '#000'); gradient.addColorStop(.38, '#030308'); gradient.addColorStop(.58, palette[1]); gradient.addColorStop(.7, 'transparent')
      draw.fillStyle = gradient; draw.fillRect(0, 0, width, height)
      points.slice(0, 150).forEach((point, index) => {
        const angle = point.phase + time * (1.2 + point.x) + index * .12
        const radius = (28 + point.y * Math.min(width, height) * .48) * (1 - progress * .62)
        draw.fillStyle = palette[index % 3]
        draw.beginPath(); draw.arc(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius * .58, point.size * .6, 0, Math.PI * 2); draw.fill()
      })
      draw.fillStyle = '#fff'; draw.font = 'bold 64px system-ui'; draw.textAlign = 'center'; draw.fillText('✓', cx, cy - 88 - Math.sin(progress * Math.PI) * 45)
    }
  }

  onDestroy(() => cleanup(true))
</script>

<canvas
  class="celebration-canvas"
  class:active={Boolean(activeDefinition)}
  bind:this={canvas}
  aria-hidden="true"
  data-celebration-id={activeDefinition?.id}
  data-celebration-engine={activeDefinition?.engine}
></canvas>

{#if activeDefinition}
  <div
    class="celebration-stage"
    class:reduced
    class:preview
    class:intense={activeDefinition.intensity >= 4}
    data-celebration-id={activeDefinition.id}
    data-celebration-engine={activeDefinition.engine}
    data-celebration-recipe={activeDefinition.recipe}
    style={`--c1:${activeDefinition.palette[0]};--c2:${activeDefinition.palette[1]};--c3:${activeDefinition.palette[2]}`}
    aria-hidden="true"
  >
    <div class="effect-wash"></div>

    {#if reduced}
      <div class="reduced-emblem"><span>{activeDefinition.icon}</span><b>✓</b></div>
    {:else if activeDefinition.recipe === 'aurora'}
      <div class="aurora-ribbon ribbon-one"></div><div class="aurora-ribbon ribbon-two"></div><div class="aurora-ribbon ribbon-three"></div>
      <div class="aurora-checks">✓　·　✓　·　✓</div>
    {:else if activeDefinition.recipe === 'goose'}
      <div class="goose-scene"><span class="goose">🪿</span><span class="deadline-paper">DEADLINE</span><b>HONK!</b></div>
    {:else if activeDefinition.recipe === 'janitor'}
      <div class="janitor-scene"><span>🧹</span><span class="janitor">🧑‍🔧</span><b>ALL CLEAR</b></div>
    {:else if activeDefinition.recipe === 'approved'}
      <div class="approval-stamp">APPROVED<small>DEPARTMENT OF DONE</small></div>
    {:else if activeDefinition.recipe === 'toaster'}
      <div class="toaster"><div class="toast toast-one">✓</div><div class="toast toast-two">✓</div><div class="toaster-body">TOASTED</div></div>
    {:else if activeDefinition.recipe === 'roomba'}
      <div class="roomba"><span>✓</span><i></i><b>CLEAN</b></div><div class="stress-cloud">CHAOS</div>
    {:else if activeDefinition.recipe === 'chorus'}
      <div class="chorus-title">THE CHECKBOX CHORUS</div>
    {:else if activeDefinition.recipe === 'papel-picado'}
      <div class="papel-string"></div>
    {:else if activeDefinition.recipe === 'dada-receipt'}
      <div class="dada-receipt"><b>RECEIPT № 1</b><span>1 DAY</span><span>100% DONE</span><span>LOGIC OPTIONAL</span><i>🐟 + 🎩 = ✓</i></div>
    {:else if activeDefinition.recipe === 'domino'}
      <div class="domino-track">{#each [1,2,3,4,5,6,7,8] as domino}<i style={`--i:${domino}`}>✓</i>{/each}</div>
    {:else if activeDefinition.recipe === 'zero-gravity'}
      <div class="gravity-core">✓<small>GRAVITY OFF</small></div>
    {:else if activeDefinition.recipe === 'zipper'}
      <div class="zipper-left"></div><div class="zipper-right"></div><div class="zipper-seam">〽〽〽〽〽〽〽</div><div class="zipper-pull">✓</div>
    {:else if activeDefinition.recipe === 'curtain'}
      <div class="curtain curtain-left"></div><div class="curtain curtain-right"></div><div class="spotlight">✓<small>BRAVO!</small></div>
    {:else if activeDefinition.recipe === 'inhale'}
      <div class="breath-ring">nothing left<br><b>to do</b></div>
    {:else if activeDefinition.recipe === 'op-art'}
      <div class="op-art"><span>✓</span></div>
    {:else if activeDefinition.recipe === 'chrome'}
      <div class="chrome-blob blob-one"></div><div class="chrome-blob blob-two"></div><div class="chrome-check">✓</div>
    {:else if activeDefinition.recipe === 'chromatic-echo'}
      <div class="rgb-panel red-panel">✓</div><div class="rgb-panel green-panel">✓</div><div class="rgb-panel blue-panel">✓</div>
    {:else if activeDefinition.recipe === 'mitosis'}
      <div class="mitosis-core">BALANCE<br>✓</div>
    {:else if activeDefinition.recipe === 'applause'}
      <div class="applause-marquee">👏　✓　👏　✓　👏</div><div class="applause-title">BALANCE DEMANDS APPLAUSE</div>
    {/if}

    {#each pieces as piece}
      <span class={`effect-piece ${piece.className}`} style={piece.style}>{piece.text ?? ''}</span>
    {/each}

    <div class="effect-signature">{activeDefinition.icon} {activeDefinition.name}</div>
  </div>
{/if}

{#if listBurst}
  <div class="list-celebration" aria-hidden="true">
    <div class="completed-list-card">
      <div class="completed-list-title"><span>✓</span> LIST COMPLETE</div>
      {#each [0, 1, 2] as index}
        <div class="completed-list-row" style={`--row-delay: ${120 + index * 90}ms`}><span>✓</span><i></i></div>
      {/each}
    </div>
    {#each CHECK_SPARKS as spark}
      <span class="check-spark" style={`--check-x:${spark.x}px;--check-y:${spark.y}px;--check-delay:${spark.delay}ms;--check-hue:${spark.hue}`}>✓</span>
    {/each}
  </div>
{/if}

{#if banner}
  <div
    class:celebration-banner={!activeDefinition}
    class:celebration-announcement={Boolean(activeDefinition)}
    class:reduced-motion={reduced}
    role="status"
    aria-live="polite"
    aria-atomic="true"
    aria-label={ariaLabel}
  >
    {message}
  </div>
{/if}

<style>
  .celebration-canvas, .celebration-stage, .list-celebration {
    position: fixed; z-index: 9998; inset: 0; width: 100%; height: 100%; pointer-events: none;
  }
  .celebration-canvas { opacity: 0; }
  .celebration-canvas.active { opacity: 1; }
  .celebration-stage { overflow: hidden; overflow: clip; contain: strict; isolation: isolate; }
  .effect-wash { position: absolute; inset: 0; opacity: .2; background: radial-gradient(circle at 50% 55%, color-mix(in srgb, var(--c2) 30%, transparent), transparent 58%); animation: wash-in 2.8s ease both; }
  .effect-signature { position: absolute; right: max(18px, env(safe-area-inset-right)); bottom: max(18px, env(safe-area-inset-bottom)); padding: 7px 12px; border: 1px solid color-mix(in srgb, var(--c1) 55%, white); border-radius: 999px; background: color-mix(in srgb, var(--paper-strong, #fff) 88%, transparent); box-shadow: 0 8px 25px #0002; color: var(--ink, #243443); font: 700 11px/1.1 system-ui; letter-spacing: .05em; animation: signature 3.2s ease both; }
  .effect-piece { position: absolute; display: grid; place-items: center; }

  .aurora-ribbon { position: absolute; left: -15%; width: 130%; height: 38%; border-radius: 50%; filter: blur(26px); mix-blend-mode: screen; transform-origin: center bottom; }
  .ribbon-one { top: 16%; background: linear-gradient(100deg, transparent, var(--c1), transparent 75%); animation: aurora 3.6s ease-in-out both; }
  .ribbon-two { top: 28%; background: linear-gradient(80deg, transparent 10%, var(--c2), transparent); animation: aurora 3.2s .15s ease-in-out reverse both; }
  .ribbon-three { top: 39%; background: linear-gradient(110deg, transparent, var(--c3), transparent 85%); animation: aurora 3.8s .3s ease-in-out both; }
  .aurora-checks { position: absolute; inset: 37% 0 auto; text-align: center; color: white; font-size: clamp(22px, 5vw, 54px); text-shadow: 0 0 20px var(--c1); animation: float-up 3.4s ease both; }

  .dandelion-seed { left: var(--x); bottom: 20%; color: var(--c2); font: 700 18px/1 serif; transform: scale(var(--scale)); animation: seed-flight 3.2s var(--delay) cubic-bezier(.2,.6,.2,1) both; }
  .firefly { left: var(--x); top: var(--y); width: 8px; height: 8px; border-radius: 50%; background: var(--c1); box-shadow: 0 0 8px 3px var(--c1), 0 0 18px 6px var(--c2); color: white; font: 11px/1 system-ui; animation: firefly 2s var(--delay) ease-in-out infinite alternate; }
  .glass-pane { left: var(--x); top: var(--y); width: 19vw; height: 38vh; border: 4px solid #251f31; background: radial-gradient(circle at 70% 20%, #fff8, transparent 22%), var(--color); color: white; font: bold 28px system-ui; transform: rotate(var(--r)); opacity: .7; animation: glass-in 2.8s var(--delay) cubic-bezier(.2,.8,.2,1) both; clip-path: polygon(8% 0, 100% 12%, 88% 100%, 0 84%); }

  .goose-scene { position: absolute; left: -22%; bottom: 9%; display: flex; align-items: end; gap: 6px; animation: goose-march 3.8s linear both; }
  .goose { font-size: clamp(58px, 10vw, 112px); filter: drop-shadow(0 12px 8px #0003); }
  .deadline-paper { padding: 10px; border: 2px solid #555; background: #fffdf2; color: #222; font: 900 14px/1 system-ui; transform: rotate(8deg); }
  .goose-scene b { position: absolute; top: -28px; left: 48%; color: var(--c3); font: 900 22px system-ui; animation: honk .7s 1.4s ease both; }
  .janitor-scene { position: absolute; left: 12%; bottom: 8%; display: flex; align-items: end; font-size: 62px; animation: janitor-sweep 4s ease-in-out both; }
  .janitor-scene .janitor { font-size: 48px; }
  .janitor-scene b { padding: 7px 10px; border-radius: 5px; background: var(--c1); color: #222; font: 900 12px system-ui; transform: rotate(-5deg); }
  .dust { left: var(--x); bottom: 13%; color: #796b59; font-size: calc(14px * var(--size)); animation: dust-sweep 2.4s var(--delay) ease both; }

  .approval-stamp { position: absolute; left: 50%; top: 48%; display: grid; gap: 4px; padding: 18px 28px; border: 7px double var(--c1); color: var(--c1); font: 1000 clamp(38px, 9vw, 96px)/.9 system-ui; letter-spacing: .06em; text-align: center; transform: translate(-50%, -50%) rotate(-8deg); filter: drop-shadow(0 10px 6px #0003); animation: stamp 2.8s cubic-bezier(.2,.9,.2,1) both; }
  .approval-stamp small { font-size: 11px; letter-spacing: .16em; }
  .bureau-seal { left: var(--x); top: var(--y); padding: 6px; border: 2px solid var(--c1); background: var(--c2); color: var(--c3); font: 800 8px system-ui; transform: rotate(var(--r)); animation: seal .5s var(--delay) ease both; }

  .toaster { position: absolute; left: 50%; bottom: 8%; width: 210px; height: 165px; transform: translateX(-50%); }
  .toaster-body { position: absolute; inset: 56px 0 0; display: grid; place-items: center; border: 5px solid #8f552b; border-radius: 25px 25px 42px 42px; background: linear-gradient(145deg, var(--c1), var(--c2)); color: #5b3218; font: 900 17px system-ui; box-shadow: inset 0 7px #fff5, 0 18px 22px #0003; }
  .toast { position: absolute; top: 44px; width: 70px; height: 68px; border: 7px solid #8f552b; border-radius: 22px 22px 10px 10px; background: var(--c3); color: #70401e; font: 900 32px system-ui; text-align: center; animation: toast-pop 3.5s cubic-bezier(.2,.9,.25,1) both; }
  .toast-one { left: 24px; transform: rotate(-7deg); } .toast-two { right: 24px; transform: rotate(8deg); animation-delay: .12s; }
  .roomba { position: absolute; bottom: 7%; left: -100px; display: grid; place-items: center; width: 96px; height: 64px; border: 6px solid #27333d; border-radius: 50%; background: var(--c1); color: white; font: bold 26px system-ui; box-shadow: 0 15px 9px #0003; animation: roomba-route 4.2s linear both; }
  .roomba i { position: absolute; top: 7px; width: 17px; height: 7px; border-radius: 5px; background: var(--c2); box-shadow: 0 0 9px var(--c2); }
  .roomba b { position: absolute; bottom: 9px; font: 800 8px system-ui; }
  .stress-cloud { position: absolute; right: 15%; bottom: 12%; padding: 18px; border-radius: 50%; background: #71788155; color: #525961; font: 800 11px system-ui; animation: vacuumed 3s .5s ease both; }
  .chorus-title { position: absolute; left: 0; right: 0; bottom: 28%; text-align: center; color: var(--c3); font: 900 13px system-ui; letter-spacing: .18em; }
  .chorus-check { left: var(--x); bottom: 10%; width: 44px; height: 44px; border: 3px solid var(--color); border-radius: 8px; background: white; color: var(--color); font: 900 30px system-ui; transform-origin: center bottom; animation: chorus-kick 1.15s var(--delay) ease-in-out 3; }

  .papel-string { position: absolute; left: 0; right: 0; top: 10%; border-top: 3px solid #443b2c; transform: rotate(-1deg); }
  .papel-flag { left: var(--x); top: 10%; width: 13vw; height: 20vh; max-height: 130px; background: var(--color); color: white; font: 900 clamp(24px, 5vw, 50px) system-ui; clip-path: polygon(0 0, 100% 0, 93% 86%, 74% 100%, 51% 88%, 28% 100%, 6% 87%); mask-image: radial-gradient(circle at 25% 30%, transparent 0 7px, black 8px), radial-gradient(circle at 75% 30%, transparent 0 7px, black 8px); animation: flag-unfurl 4.2s var(--delay) ease both; transform-origin: top; }
  .garden-tile { left: var(--x); top: var(--y); width: 10vw; height: 14vh; color: var(--color); font: bold clamp(24px, 5vw, 60px) serif; text-shadow: 0 0 1px #fff; animation: garden-grow 4s var(--delay) cubic-bezier(.2,.8,.2,1) both; }
  .dada-receipt { position: absolute; top: -30%; left: 50%; display: grid; gap: 12px; width: min(310px, 70vw); padding: 28px; border: 2px dashed #111; background: var(--c1); box-shadow: 9px 13px 0 var(--c2); color: var(--c3); font: 900 20px/1.1 ui-monospace, monospace; transform: translateX(-50%) rotate(-3deg); animation: receipt 3.7s cubic-bezier(.2,.8,.2,1) both; }
  .dada-receipt b { font-size: 13px; border-bottom: 2px solid; } .dada-receipt i { color: var(--c2); font-style: normal; font-size: 26px; }

  .domino-track { position: absolute; left: 8%; right: 8%; bottom: 11%; display: flex; justify-content: space-around; align-items: end; perspective: 600px; }
  .domino-track i { display: grid; place-items: center; width: 42px; height: 78px; border: 3px solid var(--c2); border-radius: 7px; background: var(--c1); color: var(--c3); font: 900 26px system-ui; transform-origin: bottom; animation: domino 2.3s calc(var(--i) * .09s) ease-in-out both; }
  .gravity-core, .mitosis-core { position: absolute; left: 50%; top: 50%; display: grid; place-items: center; width: 110px; height: 110px; border-radius: 50%; background: radial-gradient(circle, var(--c3), var(--c1)); color: white; font: 900 54px system-ui; transform: translate(-50%, -50%); box-shadow: 0 0 50px var(--c2); }
  .gravity-core small { font-size: 8px; letter-spacing: .12em; }
  .orbit-card { left: 50%; top: 50%; width: 42px; height: 32px; border: 2px solid var(--color); border-radius: 7px; background: white; color: var(--color); animation: orbit 3.8s var(--delay) linear both; }
  .zipper-left, .zipper-right { position: absolute; top: 0; bottom: 0; width: 51%; background: linear-gradient(120deg, color-mix(in srgb, var(--c2) 35%, transparent), transparent); animation: zipper-close 3.6s ease-in-out both; }
  .zipper-left { left: -50%; } .zipper-right { right: -50%; animation-name: zipper-close-right; }
  .zipper-seam { position: absolute; left: 50%; bottom: 0; width: 28px; color: var(--c1); font: 900 27px/.74 monospace; overflow: hidden; transform: translateX(-50%); animation: seam-grow 3.6s ease-in-out both; }
  .zipper-pull { position: absolute; left: 50%; bottom: 0; display: grid; place-items: center; width: 42px; height: 55px; border: 5px solid var(--c1); border-radius: 12px 12px 50% 50%; background: var(--c3); color: var(--c2); font: 900 25px system-ui; animation: pull-up 3.6s ease-in-out both; }
  .curtain { position: absolute; top: 0; bottom: 0; width: 52%; background: repeating-linear-gradient(90deg, var(--c1) 0 8%, var(--c3) 9% 17%, var(--c1) 18% 26%); box-shadow: inset 0 0 40px #0008; animation: curtain-call 4.2s ease-in-out both; }
  .curtain-left { left: -52%; border-radius: 0 0 80% 0; } .curtain-right { right: -52%; border-radius: 0 0 0 80%; animation-name: curtain-call-right; }
  .spotlight { position: absolute; left: 50%; top: 44%; display: grid; place-items: center; color: var(--c2); font: 900 78px system-ui; text-shadow: 0 0 45px #fff; transform: translate(-50%, -50%); animation: spotlight 4.2s ease both; }
  .spotlight small { font-size: 12px; letter-spacing: .2em; }
  .breath-ring { position: absolute; left: 50%; top: 51%; display: grid; place-items: center; width: min(55vw, 420px); aspect-ratio: 1; border: 10px solid var(--c1); border-radius: 42% 58% 54% 46%; background: color-mix(in srgb, var(--c3) 35%, transparent); color: var(--c2); font: 500 16px system-ui; text-align: center; transform: translate(-50%, -50%); animation: breathe 3.5s ease-in-out both; }
  .breath-ring b { font-size: 28px; }

  .op-art { position: absolute; left: 50%; top: 50%; width: min(78vmin, 680px); aspect-ratio: 1; border-radius: 50%; background: repeating-radial-gradient(circle, #111 0 7px, #f7f7f2 8px 15px); transform: translate(-50%, -50%); animation: op-pulse 3.8s ease-in-out both; }
  .op-art::after { content: ''; position: absolute; inset: 8%; border-radius: 50%; background: repeating-conic-gradient(#111 0 7deg, #f7f7f2 8deg 15deg); mix-blend-mode: difference; }
  .op-art span { position: absolute; z-index: 1; inset: 32%; display: grid; place-items: center; border-radius: 50%; background: conic-gradient(var(--c3), #45f3ff, #ffe14d, var(--c3)); color: white; font: 900 62px system-ui; }
  .chrome-blob { position: absolute; width: min(42vw, 430px); aspect-ratio: 1.2; border-radius: 47% 53% 62% 38% / 38% 48% 52% 62%; background: radial-gradient(circle at 30% 22%, white 0 5%, var(--c1) 12%, #24313c 32%, var(--c3) 49%, white 63%, #52606b 79%); filter: drop-shadow(0 25px 25px #0005); mix-blend-mode: screen; animation: chrome-melt 4s ease-in-out both; }
  .blob-one { left: 14%; top: 28%; } .blob-two { right: 13%; top: 37%; animation-delay: -.3s; }
  .chrome-check { position: absolute; left: 50%; top: 50%; color: white; font: 900 94px system-ui; text-shadow: 0 0 9px #222, 0 0 28px var(--c3); transform: translate(-50%, -50%); }
  .rgb-panel { position: absolute; left: 50%; top: 50%; display: grid; place-items: center; width: min(54vw, 520px); height: min(48vh, 410px); border: 9px solid currentColor; border-radius: 26px; background: currentColor; color: var(--c1); font: 900 92px system-ui; opacity: .35; mix-blend-mode: screen; animation: rgb-echo 2.8s ease-in-out both; }
  .red-panel { --dx: -18px; color: #ff2851; } .green-panel { --dx: 0px; color: #22e39f; } .blue-panel { --dx: 18px; color: #287cff; }
  .mitosis-core { border-radius: 18px; background: var(--c1); font-size: 14px; line-height: 1.7; }
  .baby-ui { left: 50%; top: 50%; width: 92px; height: 66px; border: 4px solid var(--color); border-radius: 12px; background: white; color: var(--color); white-space: pre-line; font: 800 12px/1.5 ui-monospace, monospace; animation: mitosis 4.5s var(--delay) cubic-bezier(.2,.8,.2,1) both; }
  .applause-marquee { position: absolute; left: 0; right: 0; top: 9%; padding: 12px; border-block: 4px solid var(--c1); background: var(--c3); color: white; font: 900 clamp(22px, 6vw, 58px) system-ui; text-align: center; white-space: nowrap; animation: marquee-bow 3.4s ease both; }
  .applause-title { position: absolute; left: 50%; top: 52%; padding: 22px; border: 6px double var(--c1); background: var(--c2); color: #27231b; font: 1000 clamp(28px, 7vw, 72px)/.92 system-ui; text-align: center; transform: translate(-50%, -50%); animation: stamp 3.2s ease both; }
  .reduced-emblem { position: absolute; left: 50%; top: 50%; display: grid; place-items: center; width: min(42vw, 220px); aspect-ratio: 1; border: 3px solid var(--c1); border-radius: 50%; background: radial-gradient(circle, color-mix(in srgb, var(--c2) 65%, white), color-mix(in srgb, var(--c3) 35%, transparent)); box-shadow: 0 16px 46px #0002; transform: translate(-50%, -50%); }
  .reduced-emblem span { font-size: 64px; } .reduced-emblem b { position: absolute; right: 16%; bottom: 12%; display: grid; place-items: center; width: 45px; height: 45px; border-radius: 50%; background: var(--c1); color: white; font: 900 26px system-ui; }

  .celebration-banner { position: fixed; z-index: 9999; top: max(18%, env(safe-area-inset-top)); left: 50%; max-width: min(86vw, 620px); border-radius: 999px; padding: .7rem 1.4rem; background: var(--accent, #2f6f68); box-shadow: 0 10px 30px #0004; color: #fff; font: 700 1.05rem/1.2 system-ui; letter-spacing: .01em; text-align: center; pointer-events: none; transform: translateX(-50%); animation: celebration-pop 2.2s ease forwards; }
  .celebration-banner.reduced-motion { opacity: 1; animation: none; }
  .celebration-announcement { position: fixed; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

  .list-celebration { overflow: hidden; }
  .completed-list-card { position: absolute; top: 50%; left: 50%; display: grid; gap: 9px; width: 190px; padding: 18px; border: 2px solid color-mix(in srgb, var(--accent, #2f6f68) 72%, white); border-radius: 14px; background: var(--paper-strong, #fff); box-shadow: 0 18px 55px rgba(20,40,37,.28); color: var(--accent-strong, #245952); animation: completed-list-pop 1.8s cubic-bezier(.22,.8,.25,1) both; }
  .completed-list-title { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 800; letter-spacing: .08em; }
  .completed-list-title span { display: grid; width: 25px; height: 25px; place-items: center; border-radius: 50%; background: var(--accent, #2f6f68); color: white; font-size: 17px; }
  .completed-list-row { display: flex; align-items: center; gap: 9px; opacity: 0; animation: completed-row-check 520ms ease-out var(--row-delay) forwards; }
  .completed-list-row span { display: grid; width: 18px; height: 18px; place-items: center; border-radius: 5px; background: color-mix(in srgb, var(--accent, #2f6f68) 18%, transparent); font-size: 12px; font-weight: 800; }
  .completed-list-row i { width: 70%; height: 6px; border-radius: 999px; background: color-mix(in srgb, var(--accent, #2f6f68) 22%, var(--line, #ddd)); transform-origin: left; }
  .check-spark { position: absolute; top: 50%; left: 50%; display: grid; width: 31px; height: 31px; place-items: center; border: 2px solid hsl(var(--check-hue) 64% 52%); border-radius: 50%; background: hsl(var(--check-hue) 74% 94%); box-shadow: 0 5px 14px hsl(var(--check-hue) 55% 35% / .2); color: hsl(var(--check-hue) 64% 38%); font-size: 18px; font-weight: 900; animation: check-spark-burst 1.35s cubic-bezier(.16,.76,.22,1) var(--check-delay) both; }

  @keyframes celebration-pop { 0%{opacity:0;transform:translateX(-50%) translateY(8px) scale(.9)} 12%{opacity:1;transform:translateX(-50%) scale(1.04)} 22%,80%{opacity:1;transform:translateX(-50%) scale(1)} 100%{opacity:0;transform:translateX(-50%) translateY(-6px)} }
  @keyframes wash-in { 0%,100%{opacity:0} 25%,75%{opacity:.22} }
  @keyframes signature { 0%,100%{opacity:0;transform:translateY(8px)} 18%,82%{opacity:1;transform:none} }
  @keyframes aurora { 0%,100%{opacity:0;transform:translateY(25%) skewX(-8deg) scaleY(.4)} 30%,70%{opacity:.75;transform:translateY(-8%) skewX(7deg) scaleY(1.15)} }
  @keyframes float-up { 0%,100%{opacity:0;transform:translateY(70px)} 30%,70%{opacity:1;transform:translateY(0)} }
  @keyframes seed-flight { 0%{opacity:0;transform:translate(0,40px) scale(var(--scale)) rotate(0)} 12%,70%{opacity:1} 100%{opacity:0;transform:translate(var(--drift),-88vh) scale(.45) rotate(520deg)} }
  @keyframes firefly { to{transform:translate(var(--dx),var(--dy));opacity:.25} }
  @keyframes glass-in { 0%,100%{opacity:0;transform:translateY(90px) rotate(var(--r)) scale(.5)} 25%,72%{opacity:.72;transform:rotate(var(--r)) scale(1)} }
  @keyframes goose-march { 0%{left:-22%} 38%{left:36%} 55%{left:42%;transform:rotate(-4deg)} 100%{left:115%;transform:rotate(2deg)} }
  @keyframes honk { 0%{opacity:0;transform:scale(.2)} 55%{opacity:1;transform:scale(1.3) rotate(-5deg)} 100%{opacity:0} }
  @keyframes janitor-sweep { 0%,100%{opacity:0;transform:translateX(-20vw)} 16%{opacity:1} 72%{opacity:1;transform:translateX(55vw)} 88%{transform:translateX(55vw)} }
  @keyframes dust-sweep { 0%,25%{opacity:1} 70%,100%{opacity:0;transform:translateX(40vw) scale(.2)} }
  @keyframes stamp { 0%{opacity:0;transform:translate(-50%,-50%) rotate(-24deg) scale(2.5)} 17%{opacity:1;transform:translate(-50%,-50%) rotate(-8deg) scale(.88)} 26%,78%{opacity:1;transform:translate(-50%,-50%) rotate(-8deg)} 100%{opacity:0;transform:translate(-50%,-50%) rotate(-5deg) scale(.95)} }
  @keyframes seal { from{opacity:0;transform:rotate(var(--r)) scale(2)} to{opacity:1;transform:rotate(var(--r))} }
  @keyframes toast-pop { 0%,25%{top:72px;opacity:0} 38%{top:-15px;opacity:1} 46%,82%{top:10px;opacity:1} 100%{top:-15px;opacity:0} }
  @keyframes roomba-route { 0%{left:-110px;transform:rotate(0)} 35%{left:65%;transform:rotate(8deg)} 44%{left:calc(100% - 86px);transform:rotate(3deg)} 52%{left:calc(100% - 110px);transform:rotate(-165deg)} 100%{left:-120px;transform:rotate(-182deg)} }
  @keyframes vacuumed { 0%,20%{opacity:1;transform:scale(1)} 70%,100%{opacity:0;transform:translateX(-40vw) scale(.05)} }
  @keyframes chorus-kick { 0%,100%{transform:rotate(0) translateY(0)} 35%{transform:rotate(-28deg) translateY(-18px)} 60%{transform:rotate(20deg) translateY(-8px)} }
  @keyframes flag-unfurl { 0%,100%{opacity:0;transform:scaleY(.05) rotate(0)} 18%,78%{opacity:.88;transform:scaleY(1) rotate(1.5deg)} 48%{transform:scaleY(1) rotate(-2deg)} }
  @keyframes garden-grow { 0%,100%{opacity:0;transform:scale(.1) rotate(-45deg)} 24%,72%{opacity:.8;transform:scale(1) rotate(0)} }
  @keyframes receipt { 0%{top:-45%;opacity:0} 22%,74%{top:17%;opacity:1} 100%{top:115%;opacity:0;transform:translateX(-50%) rotate(8deg)} }
  @keyframes domino { 0%,100%{opacity:0;transform:rotateX(0)} 18%{opacity:1} 48%{opacity:1;transform:rotateX(72deg) translateY(8px)} 72%{transform:rotateX(0)} }
  @keyframes orbit { 0%,100%{opacity:0;transform:translate(-50%,-50%) rotate(var(--angle)) translateX(20px) rotate(calc(var(--angle) * -1)) scale(.2)} 20%,78%{opacity:1} 52%{transform:translate(-50%,-50%) rotate(calc(var(--angle) + 240deg)) translateX(var(--radius)) rotate(calc((var(--angle) + 240deg) * -1))} }
  @keyframes zipper-close { 0%,100%{opacity:0;transform:translateX(0)} 30%,70%{opacity:.8;transform:translateX(98%)} }
  @keyframes zipper-close-right { 0%,100%{opacity:0;transform:translateX(0)} 30%,70%{opacity:.8;transform:translateX(-98%)} }
  @keyframes seam-grow { 0%,100%{height:0;opacity:0} 28%,70%{height:100%;opacity:1} }
  @keyframes pull-up { 0%,100%{bottom:-70px;opacity:0} 25%{opacity:1} 62%{bottom:82%;opacity:1} }
  @keyframes curtain-call { 0%,100%{opacity:0;transform:translateX(0)} 26%,68%{opacity:.95;transform:translateX(96%)} }
  @keyframes curtain-call-right { 0%,100%{opacity:0;transform:translateX(0)} 26%,68%{opacity:.95;transform:translateX(-96%)} }
  @keyframes spotlight { 0%,100%{opacity:0;transform:translate(-50%,-40%) scale(.7)} 35%,68%{opacity:1;transform:translate(-50%,-50%) scale(1)} }
  @keyframes breathe { 0%,100%{opacity:0;transform:translate(-50%,-50%) scale(.72);border-radius:42% 58%} 25%{opacity:.8} 48%{transform:translate(-50%,-50%) scale(1.16);border-radius:55% 45%} 78%{opacity:.7;transform:translate(-50%,-50%) scale(.9)} }
  @keyframes op-pulse { 0%,100%{opacity:0;transform:translate(-50%,-50%) scale(.4) rotate(0)} 25%,75%{opacity:.62;transform:translate(-50%,-50%) scale(1) rotate(8deg)} 50%{transform:translate(-50%,-50%) scale(1.12) rotate(-5deg)} }
  @keyframes chrome-melt { 0%,100%{opacity:0;transform:scale(.2) rotate(-20deg)} 25%,75%{opacity:.75;transform:scale(1) rotate(5deg)} 52%{transform:translateX(8vw) scale(1.2) rotate(-5deg)} }
  @keyframes rgb-echo { 0%,100%{opacity:0;transform:translate(-50%,-50%)} 25%,70%{opacity:.3;transform:translate(calc(-50% + var(--dx)),-50%) scale(1.04)} 82%{opacity:.5;transform:translate(-50%,-50%) scale(1)} }
  @keyframes mitosis { 0%,100%{opacity:0;transform:translate(-50%,-50%) rotate(var(--angle)) translateX(0) scale(.1)} 25%{opacity:1;transform:translate(-50%,-50%) rotate(var(--angle)) translateX(150px) rotate(calc(var(--angle) * -1)) scale(1)} 68%{opacity:1;transform:translate(-50%,-50%) rotate(calc(var(--angle) + 250deg)) translateX(150px) rotate(calc((var(--angle) + 250deg) * -1)) scale(.8)} }
  @keyframes marquee-bow { 0%,100%{opacity:0;transform:translateY(-60px)} 22%,70%{opacity:1;transform:translateY(0) scaleX(1)} 48%{transform:translateY(9px) scaleX(.95)} }
  @keyframes completed-list-pop { 0%{opacity:0;transform:translate(-50%,-42%) rotate(-9deg) scale(.48)} 18%{opacity:1;transform:translate(-50%,-50%) rotate(3deg) scale(1.12)} 31%,76%{opacity:1;transform:translate(-50%,-50%)} 100%{opacity:0;transform:translate(-50%,-62%) rotate(2deg) scale(.94)} }
  @keyframes completed-row-check { from{opacity:0;transform:translateX(-12px) scale(.92)} to{opacity:1;transform:none} }
  @keyframes check-spark-burst { 0%{opacity:0;transform:translate(-50%,-50%) rotate(-20deg) scale(.15)} 18%{opacity:1} 72%{opacity:1;transform:translate(calc(-50% + var(--check-x)),calc(-50% + var(--check-y))) rotate(8deg)} 100%{opacity:0;transform:translate(calc(-50% + var(--check-x)),calc(-50% + var(--check-y))) rotate(18deg) scale(.72)} }

  @supports not (color: color-mix(in srgb, white, black)) {
    .effect-wash { background: radial-gradient(circle, rgba(120,120,220,.25), transparent 58%); }
    .effect-signature { background: #fff; border-color: #bbb; }
  }
  @supports (backdrop-filter: blur(2px)) {
    .effect-signature { backdrop-filter: blur(8px); }
  }
  @media (prefers-reduced-motion: reduce) {
    .celebration-stage *, .celebration-banner, .list-celebration { animation: none !important; }
    .list-celebration { display: none; }
    .effect-wash { opacity: .12; }
  }
</style>
