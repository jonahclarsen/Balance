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
      return Array.from({ length: 18 }, (_, index) => {
        const x = 18 + index * 6 + random() * 5
        return {
          className: 'dust', text: index % 3 === 0 ? '×' : '·',
          style: `--x:calc(50vw + ${x}px);--delay:${1.55 + (index % 4) * 0.43 + Math.floor(index / 4) * 0.06}s;--size:${0.7 + random()}`,
        }
      })
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
    if (recipe === 'poltergeist') {
      return Array.from({ length: 14 }, (_, index) => {
        const radius = 110 + (index % 4) * 48
        return {
          className: 'haunted-card', text: index % 3 === 0 ? '✓' : index % 3 === 1 ? '—  —' : '☰',
          style: `--angle:${index * 25.7}deg;--radius:${radius}px;--radius-mid:${radius * .55}px;--radius-wide:${radius * 1.2}px;--delay:${index * -0.08}s;--color:${definition.palette[index % 3]}`,
        }
      })
    }
    if (recipe === 'recursive-fever') {
      return Array.from({ length: 9 }, (_, index) => ({
        className: 'fever-window', text: `BALANCE\n${'□ '.repeat((index % 3) + 1)}✓`,
        style: `--depth:${index * 58}px;--turn:${index * 23}deg;--x:${(index - 4) * 7}vw;--y:${(index - 4) * 5}vh;--delay:${index * 0.07}s;--color:${definition.palette[index % 3]}`,
      }))
    }
    if (recipe === 'buffer-overflow') {
      return Array.from({ length: 10 }, (_, index) => {
        const direction = index % 2 === 0 ? -1 : 1
        return {
          className: 'buffer-slab', text: index % 2 === 0 ? '//// SYSTEM OK ////' : '✓ ✓ ✓ ✓ ✓',
          style: `--y:${index * 10}%;--shift-a:${direction * 17}vw;--shift-b:${direction * -24}vw;--shift-c:${direction * 9}vw;--shift-d:${direction * -4}vw;--color:${definition.palette[index % 3]}`,
        }
      })
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
    } else if (recipe === 'poltergeist') {
      addAnimation(shell, [
        { transform: 'perspective(1000px) rotate3d(0,0,0,0deg) scale(1)', filter: 'saturate(1)' },
        { transform: 'perspective(1000px) rotate3d(.15,.7,.2,9deg) scale(.91)', filter: 'saturate(1.8)', offset: 0.24 },
        { transform: 'perspective(1000px) rotate3d(.7,-.2,.4,-12deg) scale(1.08)', filter: 'saturate(2.1) hue-rotate(65deg)', offset: 0.56 },
        { transform: 'perspective(1000px) rotate3d(-.3,.4,.8,7deg) scale(.96)', filter: 'saturate(1.5) hue-rotate(-35deg)', offset: 0.78 },
        { transform: 'perspective(1000px) rotate3d(0,0,0,0deg) scale(1)', filter: 'saturate(1)' },
      ], { duration: 4900, easing: 'cubic-bezier(.45,-.25,.2,1.3)' })
      rows.forEach((row, index) => addAnimation(row, [
        { transform: 'translate(0,0) rotate(0deg)', opacity: 1 },
        { transform: `translate(${(index % 2 ? -1 : 1) * (80 + index * 7)}px, ${-70 + (index % 5) * 36}px) rotate(${index % 2 ? -35 : 42}deg)`, opacity: .75, offset: 0.45 },
        { transform: `translate(${(index % 3 - 1) * 55}px, ${(index % 4 - 2) * 45}px) rotate(${index * 11}deg)`, opacity: .9, offset: 0.7 },
        { transform: 'translate(0,0) rotate(0deg)', opacity: 1 },
      ], { duration: 4300, delay: index * 32, easing: 'cubic-bezier(.2,.9,.2,1)' }))
    } else if (recipe === 'non-euclidean') {
      addAnimation(pane, [
        { transform: 'perspective(900px) rotateX(0) rotateY(0) skew(0)', transformOrigin: '50% 50%' },
        { transform: 'perspective(900px) rotateX(58deg) rotateY(-22deg) skewY(8deg) scale(.72)', transformOrigin: '10% 10%', offset: 0.32 },
        { transform: 'perspective(900px) rotateX(-18deg) rotateY(68deg) skewX(-14deg) scale(.82)', transformOrigin: '90% 20%', offset: 0.64 },
        { transform: 'perspective(900px) rotateX(0) rotateY(0) skew(0)', transformOrigin: '50% 50%' },
      ], { duration: 5100, easing: 'cubic-bezier(.6,-.15,.25,1.18)' })
      addAnimation(sidebar, [
        { transform: 'translate(0,0) rotate(0deg)' },
        { transform: 'translate(42vw,-16vh) rotate(88deg) scale(.78)', offset: 0.38 },
        { transform: 'translate(67vw,38vh) rotate(181deg) scale(.62)', offset: 0.68 },
        { transform: 'translate(0,0) rotate(360deg)' },
      ], { duration: 5000, easing: 'cubic-bezier(.3,.8,.2,1)' })
    } else if (recipe === 'recursive-fever') {
      addAnimation(shell, [
        { transform: 'scale(1)', filter: 'hue-rotate(0deg) saturate(1)' },
        { transform: 'scale(.82) rotate(-2deg)', filter: 'hue-rotate(110deg) saturate(2.4)', offset: 0.28 },
        { transform: 'scale(1.12) rotate(3deg)', filter: 'hue-rotate(250deg) saturate(2)', offset: 0.6 },
        { transform: 'scale(.94) rotate(-1deg)', filter: 'hue-rotate(330deg) saturate(1.7)', offset: 0.82 },
        { transform: 'scale(1)', filter: 'hue-rotate(360deg) saturate(1)' },
      ], { duration: 5300, easing: 'ease-in-out' })
      rows.forEach((row, index) => addAnimation(row, [
        { transform: 'translateX(0) scaleX(1)' },
        { transform: `translateX(${index % 2 ? -18 : 18}vw) scaleX(${index % 3 ? .55 : 1.45})`, offset: 0.44 },
        { transform: `translateX(${index % 2 ? 8 : -8}vw) scaleX(${index % 3 ? 1.25 : .7})`, offset: 0.7 },
        { transform: 'translateX(0) scaleX(1)' },
      ], { duration: 4400, delay: index * 44, easing: 'cubic-bezier(.4,0,.2,1)' }))
    } else if (recipe === 'buffer-overflow') {
      addAnimation(shell, [
        { transform: 'translate(0,0) skew(0)', filter: 'none', clipPath: 'inset(0 0 0 0)' },
        { transform: 'translate(-5vw,2vh) skewX(7deg)', filter: 'hue-rotate(55deg) saturate(2)', clipPath: 'inset(4% 0 13% 0)', offset: 0.2 },
        { transform: 'translate(7vw,-3vh) skewY(-5deg)', filter: 'hue-rotate(170deg) saturate(2.3)', clipPath: 'inset(20% 0 2% 0)', offset: 0.43 },
        { transform: 'translate(-2vw,4vh) skewX(-9deg) scale(1.08)', filter: 'hue-rotate(285deg) saturate(1.8)', clipPath: 'inset(7% 0 26% 0)', offset: 0.68 },
        { transform: 'translate(0,0) skew(0)', filter: 'none', clipPath: 'inset(0 0 0 0)' },
      ], { duration: 4700, easing: 'steps(8, jump-none)' })
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
    {:else if activeDefinition.recipe === 'bell-of-now'}
      <div class="presence-ripple ripple-one"></div><div class="presence-ripple ripple-two"></div><div class="presence-ripple ripple-three"></div>
      <div class="presence-bell">
        <svg viewBox="0 0 180 205" role="presentation">
          <defs>
            <linearGradient id="bell-bronze" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stop-color="#5a3515"></stop>
              <stop offset=".15" stop-color="#9b6425"></stop>
              <stop offset=".37" stop-color="#e4bd69"></stop>
              <stop offset=".51" stop-color="#f8e4a5"></stop>
              <stop offset=".68" stop-color="#bd7d2d"></stop>
              <stop offset=".88" stop-color="#7a491c"></stop>
              <stop offset="1" stop-color="#432811"></stop>
            </linearGradient>
            <linearGradient id="bell-rim" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stop-color="#f0cc78"></stop>
              <stop offset=".42" stop-color="#9b5f20"></stop>
              <stop offset="1" stop-color="#4a2b12"></stop>
            </linearGradient>
            <radialGradient id="bell-mouth" cx="50%" cy="18%" r="78%">
              <stop offset="0" stop-color="#5f3918"></stop>
              <stop offset=".58" stop-color="#2d1b0e"></stop>
              <stop offset="1" stop-color="#120c08"></stop>
            </radialGradient>
            <clipPath id="bell-opening">
              <ellipse cx="90" cy="159" rx="56" ry="15"></ellipse>
            </clipPath>
          </defs>
          <ellipse class="presence-bell-shadow" cx="90" cy="187" rx="54" ry="8"></ellipse>
          <g class="presence-bell-body">
            <path class="presence-bell-handle" d="M70 37 C70 20 77 10 90 10 C103 10 110 20 110 37"></path>
            <path class="presence-bell-handle-light" d="M78 35 C78 23 82 18 90 18"></path>
            <ellipse class="presence-bell-crown" cx="90" cy="39" rx="25" ry="9"></ellipse>
            <path class="presence-bell-casting" d="M90 34 C70 34 60 50 59 72 C57 103 51 126 33 146 C27 153 30 161 39 164 C68 175 112 175 141 164 C150 161 153 153 147 146 C129 126 123 103 121 72 C120 50 110 34 90 34 Z"></path>
            <path class="presence-bell-shoulder" d="M60 72 C71 66 109 66 120 72"></path>
            <path class="presence-bell-highlight" d="M76 47 C68 61 69 91 63 116 C60 129 54 142 46 151"></path>
            <ellipse class="presence-bell-mouth" cx="90" cy="159" rx="58" ry="17"></ellipse>
            <g class="presence-bell-clapper">
              <path class="presence-bell-clapper-rod" d="M90 67 L90 165"></path>
              <ellipse cx="90" cy="169" rx="12" ry="14"></ellipse>
              <path class="presence-bell-clapper-light" d="M84 164 C87 159 93 158 97 163"></path>
            </g>
            <path class="presence-bell-lip" d="M31 151 C52 163 128 163 149 151 L153 160 C128 178 52 178 27 160 Z"></path>
            <path class="presence-bell-lip-light" d="M38 155 C63 165 117 165 142 155"></path>
          </g>
        </svg>
      </div>
      <b class="presence-words">YOU ARE HERE <i>+</i> NOW</b>
    {:else if activeDefinition.recipe === 'metta-ripple'}
      <div class="metta-halo halo-one"></div><div class="metta-halo halo-two"></div><div class="metta-halo halo-three"></div>
      <div class="metta-heart">♡<span>✓</span></div>
      <p class="metta-wish wish-self">May I be well</p>
      <p class="metta-wish wish-you">May you be well</p>
      <p class="metta-wish wish-all">May all be well</p>
    {:else if activeDefinition.recipe === 'enough'}
      <div class="enough-scene">
        <div class="enough-candle"><i></i><span></span></div>
        <p><small>this day was lived</small><b>and it is enough</b></p>
      </div>
    {:else if activeDefinition.recipe === 'goose'}
      <div class="goose-scene"><span class="goose">🪿</span><span class="deadline-paper">DEADLINE</span><b>HONK!</b></div>
    {:else if activeDefinition.recipe === 'janitor'}
      <div class="janitor-scene">
        <svg class="janitor" viewBox="0 0 240 220" role="presentation">
          <ellipse class="janitor-shadow" cx="118" cy="202" rx="79" ry="9"></ellipse>
          <g class="janitor-person">
            <g class="janitor-back-leg">
              <path class="janitor-trouser" d="M94 139 L94 181 L78 200"></path>
              <path class="janitor-boot" d="M80 195 Q71 200 68 207 L98 207 Q100 202 93 197 Z"></path>
            </g>
            <g class="janitor-front-leg">
              <g class="janitor-front-leg-art">
                <path class="janitor-trouser" d="M119 139 L126 178 L145 198"></path>
                <path class="janitor-boot" d="M140 193 Q151 197 157 204 L154 209 L126 207 Q126 200 133 196 Z"></path>
              </g>
            </g>

            <path class="janitor-shirt" d="M77 78 Q91 68 111 72 Q133 76 143 98 L132 143 Q105 153 76 140 L68 101 Q68 87 77 78 Z"></path>
            <path class="janitor-overalls" d="M86 85 L101 91 L120 83 L132 143 Q105 153 76 140 Z"></path>
            <path class="janitor-bib" d="M87 80 L118 80 L122 121 Q104 128 85 120 Z"></path>
            <path class="janitor-strap" d="M84 76 L91 77 L96 102 L89 104 Z"></path>
            <path class="janitor-strap" d="M115 77 L122 80 L116 103 L109 101 Z"></path>
            <circle class="janitor-button" cx="93" cy="104" r="3"></circle>
            <circle class="janitor-button" cx="113" cy="104" r="3"></circle>
            <path class="janitor-pocket" d="M94 109 Q104 114 114 109 L113 119 Q103 123 95 118 Z"></path>

            <g class="janitor-head">
              <path class="janitor-neck" d="M91 72 L94 60 L111 61 L114 78 Q103 86 91 72 Z"></path>
              <circle class="janitor-face" cx="101" cy="43" r="26"></circle>
              <path class="janitor-ear" d="M79 42 Q70 41 72 50 Q74 58 81 55"></path>
              <path class="janitor-hair" d="M78 40 Q77 15 102 14 Q122 14 129 35 Q116 31 106 24 Q96 35 78 40 Z"></path>
              <path class="janitor-nose" d="M124 39 Q131 42 124 45"></path>
              <circle class="janitor-eye" cx="117" cy="35" r="2.6"></circle>
              <path class="janitor-smile" d="M116 53 Q121 57 125 52"></path>
              <path class="janitor-cap" d="M76 30 Q78 7 104 8 Q121 8 129 24 Z"></path>
              <path class="janitor-cap-brim" d="M96 27 Q121 20 137 28 Q123 34 99 33 Z"></path>
            </g>

            <g class="janitor-rear-arm">
              <path class="janitor-sleeve" d="M123 82 Q137 78 147 93 L160 112 L147 122 L130 105 Z"></path>
              <path class="janitor-skin" d="M153 108 Q159 111 163 119 L158 132 Q151 128 145 119 Z"></path>
            </g>

            <g class="janitor-front-arm">
              <path class="janitor-sleeve" d="M75 82 Q64 83 63 97 Q79 113 96 123 L106 110 Q87 99 75 82 Z"></path>
              <path class="janitor-skin" d="M93 117 Q123 134 161 145 L167 131 Q132 122 103 107 Z"></path>
            </g>

            <g class="janitor-broom">
              <path class="broom-handle" d="M154 105 L179 188"></path>
              <path class="broom-collar" d="M167 181 L187 176 L191 187 L171 192 Z"></path>
              <path class="broom-bristles" d="M172 190 Q188 185 199 183 L212 204 Q187 214 157 209 Z"></path>
              <path class="broom-bristle-line" d="M171 193 L167 207 M180 190 L179 210 M189 188 L192 207 M197 187 L204 203"></path>
              <circle class="janitor-hand" cx="160" cy="125" r="8"></circle>
              <circle class="janitor-hand" cx="166" cy="145" r="8"></circle>
            </g>
          </g>
          <g class="janitor-dust-puff">
            <circle cx="215" cy="191" r="4"></circle>
            <circle cx="225" cy="184" r="3"></circle>
            <circle cx="232" cy="194" r="2"></circle>
          </g>
        </svg>
      </div>
      <b class="janitor-all-clear"><span>✓</span> ALL CLEAR</b>
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
    {:else if activeDefinition.recipe === 'poltergeist'}
      <div class="poltergeist-eye"><span>✓</span></div><div class="poltergeist-vortex"></div>
    {:else if activeDefinition.recipe === 'non-euclidean'}
      <div class="impossible-room">
        <i class="impossible-floor"></i><i class="impossible-wall wall-a"></i><i class="impossible-wall wall-b"></i>
        <b>THIS CORNER<br>HAS TOO MANY<br>CORNERS</b><span>✓</span>
      </div>
    {:else if activeDefinition.recipe === 'recursive-fever'}
      <div class="fever-core">YOU ARE HERE<div>YOU ARE ALSO HERE<div>STILL HERE</div></div></div>
    {:else if activeDefinition.recipe === 'buffer-overflow'}
      <div class="overflow-meter"><span>REALITY</span><b>137%</b><i></i></div>
    {:else if activeDefinition.recipe === 'applause'}
      <div class="applause-marquee">👏　✓　👏　✓　👏</div><div class="applause-title">BALANCE DEMANDS APPLAUSE</div>
    {/if}

    {#each pieces as piece}
      <span class={`effect-piece ${piece.className}`} style={piece.style}>{piece.text ?? ''}</span>
    {/each}

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
  .effect-piece { position: absolute; display: grid; place-items: center; }

  .aurora-ribbon { position: absolute; left: -15%; width: 130%; height: 38%; border-radius: 50%; filter: blur(26px); mix-blend-mode: screen; transform-origin: center bottom; }
  .ribbon-one { top: 16%; background: linear-gradient(100deg, transparent, var(--c1), transparent 75%); animation: aurora 3.6s ease-in-out both; }
  .ribbon-two { top: 28%; background: linear-gradient(80deg, transparent 10%, var(--c2), transparent); animation: aurora 3.2s .15s ease-in-out reverse both; }
  .ribbon-three { top: 39%; background: linear-gradient(110deg, transparent, var(--c3), transparent 85%); animation: aurora 3.8s .3s ease-in-out both; }
  .aurora-checks { position: absolute; inset: 37% 0 auto; text-align: center; color: white; font-size: clamp(22px, 5vw, 54px); text-shadow: 0 0 20px var(--c1); animation: float-up 3.4s ease both; }

  .presence-ripple { position: absolute; left: 50%; top: 50%; width: min(24vmin, 180px); aspect-ratio: 1; border: 2px solid var(--c1); border-radius: 50%; box-shadow: 0 0 24px color-mix(in srgb, var(--c1) 28%, transparent); transform: translate(-50%, -50%); animation: presence-ripple 3.7s ease-out both; }
  .ripple-two { animation-delay: .42s; } .ripple-three { animation-delay: .84s; }
  .presence-bell { position: absolute; z-index: 2; left: 50%; top: 44%; width: clamp(116px, 17vmin, 168px); aspect-ratio: 180 / 205; transform: translate(-50%, -50%); animation: presence-bell 4.2s ease-in-out both; }
  .presence-bell svg { display: block; width: 100%; height: 100%; overflow: visible; filter: drop-shadow(0 13px 12px #3d29182e); }
  .presence-bell-shadow { fill: #33211438; filter: blur(4px); animation: presence-bell-shadow 4.2s ease-in-out both; }
  .presence-bell-body { transform-origin: 90px 12px; animation: presence-bell-swing 4.2s cubic-bezier(.36,.08,.2,1) both; }
  .presence-bell-handle { fill: none; stroke: #7b4a1d; stroke-width: 11; stroke-linecap: round; }
  .presence-bell-handle-light { fill: none; stroke: #ebc873; stroke-width: 3; stroke-linecap: round; opacity: .8; }
  .presence-bell-crown { fill: url(#bell-bronze); stroke: #684019; stroke-width: 2.5; }
  .presence-bell-casting { fill: url(#bell-bronze); stroke: #593515; stroke-width: 2.5; stroke-linejoin: round; }
  .presence-bell-shoulder { fill: none; stroke: #f3d78a; stroke-width: 2; opacity: .5; }
  .presence-bell-highlight { fill: none; stroke: #fff2bd; stroke-width: 5; stroke-linecap: round; opacity: .55; }
  .presence-bell-mouth { fill: url(#bell-mouth); stroke: #553115; stroke-width: 3; }
  .presence-bell-clapper { transform-origin: 90px 67px; animation: presence-bell-clapper 4.2s cubic-bezier(.36,.08,.2,1) both; }
  .presence-bell-clapper path { fill: none; stroke: #3b2514; stroke-width: 5; stroke-linecap: round; }
  .presence-bell-clapper-rod { clip-path: url(#bell-opening); }
  .presence-bell-clapper ellipse { fill: #7f4d1e; stroke: #3e2714; stroke-width: 2; }
  .presence-bell-clapper .presence-bell-clapper-light { stroke: #d59a45; stroke-width: 2; opacity: .75; }
  .presence-bell-lip { fill: url(#bell-rim); stroke: #4b2d13; stroke-width: 2.5; stroke-linejoin: round; }
  .presence-bell-lip-light { fill: none; stroke: #f6d98a; stroke-width: 2.5; stroke-linecap: round; opacity: .7; }
  .presence-words { position: absolute; z-index: 3; left: 50%; top: 63%; isolation: isolate; padding: .82em 1.12em .82em 1.32em; color: #fffaf0; font: 720 clamp(14px, 2.2vw, 22px)/1 ui-rounded, system-ui; letter-spacing: .22em; text-shadow: 0 2px 6px #4b332599; white-space: nowrap; transform: translateX(-50%); animation: presence-words 4.2s ease both; }
  .presence-words::before { content: ''; position: absolute; z-index: -2; inset: -.3em -.95em; border-radius: 17px; background: radial-gradient(ellipse at 26% 32%, #ffd88f8c 0 7%, transparent 28%), radial-gradient(ellipse at 72% 70%, #496e5a38, transparent 34%), linear-gradient(98deg, #d6a23f, #cf7167 51%, #668f78); box-shadow: 0 8px 22px #795a3438, 0 0 25px #e5ae5b52; animation: presence-wash 2.6s ease-in-out infinite alternate; }
  .presence-words::after { content: ''; position: absolute; z-index: -1; inset: .18em -.45em; border-radius: 17px; background: linear-gradient(96deg, #fff3 0 18%, transparent 35% 66%, #fff2 82%); }
  .presence-words i { color: #ffe29a; font-style: normal; text-shadow: 0 1px 5px #6b3f2e; }

  .metta-halo { position: absolute; left: 50%; top: 50%; width: min(20vmin, 150px); aspect-ratio: 1; border: 2px solid var(--c1); border-radius: 50%; background: color-mix(in srgb, var(--c3) 16%, transparent); transform: translate(-50%, -50%); animation: metta-halo 3.6s ease-out both; }
  .halo-two { border-color: var(--c2); animation-delay: .55s; } .halo-three { border-color: var(--c1); animation-delay: 1.1s; }
  .metta-heart { position: absolute; z-index: 2; left: 50%; top: 50%; display: grid; width: clamp(78px, 13vmin, 128px); aspect-ratio: 1; place-items: center; border-radius: 50%; background: radial-gradient(circle at 35% 28%, #fff9, transparent 22%), color-mix(in srgb, var(--c1) 74%, var(--c3)); box-shadow: 0 16px 38px color-mix(in srgb, var(--c1) 35%, transparent); color: white; font: 300 clamp(58px, 9vmin, 88px)/1 serif; transform: translate(-50%, -50%); animation: metta-heart 4.8s ease-in-out both; }
  .metta-heart span { position: absolute; right: 7%; bottom: 6%; display: grid; width: 31%; aspect-ratio: 1; place-items: center; border: 2px solid var(--c3); border-radius: 50%; background: var(--c2); color: white; font: 800 clamp(13px, 2vmin, 20px)/1 system-ui; }
  .metta-wish { position: absolute; z-index: 3; left: 50%; top: 50%; margin: 0; border-radius: 999px; padding: .55em 1em; background: color-mix(in srgb, var(--c3) 82%, transparent); box-shadow: 0 8px 24px #5f39401f; color: color-mix(in srgb, var(--c2) 72%, #352a29); font: 600 clamp(13px, 1.8vw, 18px)/1.2 system-ui; white-space: nowrap; transform: translate(-50%, -50%); animation: metta-wish 3.8s ease both; }
  .wish-self { --wish-x: 0px; --wish-y: -122px; animation-delay: 0s; }
  .wish-you { --wish-x: clamp(-150px, -14vw, -64px); --wish-y: 122px; animation-delay: .48s; }
  .wish-all { --wish-x: clamp(64px, 14vw, 150px); --wish-y: 122px; animation-delay: .96s; }

  .enough-scene { position: absolute; left: 50%; top: 50%; display: grid; grid-template-columns: auto auto; align-items: center; gap: clamp(22px, 4vw, 48px); transform: translate(-50%, -50%); animation: enough-arrive 4.4s ease both; }
  .enough-candle { position: relative; width: clamp(58px, 9vmin, 88px); height: clamp(102px, 16vmin, 156px); border-radius: 9px 9px 16px 16px; background: linear-gradient(90deg, color-mix(in srgb, var(--c3) 82%, white), var(--c3) 54%, color-mix(in srgb, var(--c3) 82%, var(--c2))); box-shadow: inset -12px 0 18px #6f554521, 0 20px 28px #4a35232b; }
  .enough-candle::after { content: ''; position: absolute; inset: auto 15% 9%; height: 2px; border-radius: 50%; background: color-mix(in srgb, var(--c2) 28%, transparent); }
  .enough-candle i { position: absolute; left: 50%; bottom: calc(100% + 7px); width: 42%; aspect-ratio: .72; border-radius: 56% 44% 58% 42% / 66% 60% 40% 34%; background: radial-gradient(circle at 50% 68%, #fff8 0 9%, transparent 10%), linear-gradient(var(--c3), var(--c1) 62%, #d66f38); box-shadow: 0 0 20px 7px color-mix(in srgb, var(--c1) 35%, transparent); transform: translateX(-50%); transform-origin: center bottom; animation: enough-flame 1.8s ease-in-out infinite alternate; }
  .enough-candle span { position: absolute; left: 50%; top: -7px; width: 3px; height: 11px; border-radius: 2px; background: #4d392d; transform: translateX(-50%); }
  .enough-scene p { display: grid; gap: .5rem; min-width: max-content; margin: 0; color: var(--c2); }
  .enough-scene small { font: 500 clamp(13px, 1.8vw, 18px)/1.2 system-ui; letter-spacing: .08em; }
  .enough-scene b { color: color-mix(in srgb, var(--c2) 76%, #392c2a); font: 650 clamp(22px, 4vw, 42px)/1.05 system-ui; }

  .dandelion-seed { left: var(--x); bottom: 20%; color: var(--c2); font: 700 18px/1 serif; transform: scale(var(--scale)); animation: seed-flight 3.2s var(--delay) cubic-bezier(.2,.6,.2,1) both; }
  .firefly { left: var(--x); top: var(--y); width: 8px; height: 8px; border-radius: 50%; background: var(--c1); box-shadow: 0 0 8px 3px var(--c1), 0 0 18px 6px var(--c2); color: white; font: 11px/1 system-ui; animation: firefly 2s var(--delay) ease-in-out infinite alternate; }
  .glass-pane { left: var(--x); top: var(--y); width: 19vw; height: 38vh; border: 4px solid #251f31; background: radial-gradient(circle at 70% 20%, #fff8, transparent 22%), var(--color); color: white; font: bold 28px system-ui; transform: rotate(var(--r)); opacity: .7; animation: glass-in 2.8s var(--delay) cubic-bezier(.2,.8,.2,1) both; clip-path: polygon(8% 0, 100% 12%, 88% 100%, 0 84%); }

  .goose-scene { position: absolute; left: -22%; bottom: 9%; display: flex; align-items: end; gap: 6px; animation: goose-march 3.8s linear both; }
  .goose { font-size: clamp(58px, 10vw, 112px); filter: drop-shadow(0 12px 8px #0003); }
  .deadline-paper { padding: 10px; border: 2px solid #555; background: #fffdf2; color: #222; font: 900 14px/1 system-ui; transform: rotate(8deg); }
  .goose-scene b { position: absolute; top: -28px; left: 48%; color: var(--c3); font: 900 22px system-ui; animation: honk .7s 1.4s ease both; }
  .janitor-scene { position: absolute; left: -210px; bottom: clamp(64px, 9vh, 92px); width: clamp(145px, 17vw, 210px); filter: drop-shadow(0 10px 9px #0002); animation: janitor-route 5s linear both; }
  .janitor { display: block; width: 100%; overflow: visible; }
  .janitor-person { transform-box: fill-box; transform-origin: center bottom; animation: janitor-performance 5s ease-in-out both; }
  .janitor-shadow { fill: #25323b2e; transform-box: fill-box; transform-origin: center; animation: janitor-shadow 5s ease-in-out both; }
  .janitor-shirt { fill: color-mix(in srgb, var(--c1) 72%, #f4f0df); stroke: #26343c; stroke-width: 4; stroke-linejoin: round; }
  .janitor-overalls, .janitor-bib { fill: #315a70; stroke: #243b48; stroke-width: 4; stroke-linejoin: round; }
  .janitor-strap { fill: none; stroke: #243b48; stroke-width: 5; stroke-linecap: round; }
  .janitor-button { fill: var(--c1); stroke: #243b48; stroke-width: 1.5; }
  .janitor-pocket { fill: none; stroke: #8db1c0; stroke-width: 2; stroke-linecap: round; }
  .janitor-face, .janitor-neck, .janitor-skin, .janitor-hand, .janitor-ear { fill: #b96f48; stroke: #3d302b; stroke-width: 3.5; stroke-linecap: round; stroke-linejoin: round; }
  .janitor-ear, .janitor-nose, .janitor-smile { fill: none; }
  .janitor-hair { fill: #49362d; stroke: #3d302b; stroke-width: 3.5; stroke-linejoin: round; }
  .janitor-eye { fill: #252526; }
  .janitor-smile { stroke: #633627; stroke-width: 2.5; }
  .janitor-cap { fill: var(--c1); stroke: #26343c; stroke-width: 4; stroke-linejoin: round; }
  .janitor-cap-brim { fill: color-mix(in srgb, var(--c1) 76%, #18252c); stroke: #26343c; stroke-width: 3; stroke-linejoin: round; }
  .janitor-sleeve { fill: color-mix(in srgb, var(--c1) 72%, #f4f0df); stroke: #26343c; stroke-width: 4; stroke-linejoin: round; }
  .janitor-trouser { fill: none; stroke: #243b48; stroke-width: 19; stroke-linecap: round; stroke-linejoin: round; }
  .janitor-boot { fill: #273137; stroke: #172027; stroke-width: 3; stroke-linejoin: round; }
  .janitor-head { transform-box: fill-box; transform-origin: center bottom; animation: janitor-head-performance 5s ease-in-out both; }
  .janitor-back-leg, .janitor-front-leg { transform-box: fill-box; transform-origin: center top; }
  .janitor-back-leg { animation: janitor-back-step 5s ease-in-out both; }
  .janitor-front-leg { animation: janitor-front-step 5s ease-in-out both; }
  .janitor-front-leg-art { transform-box: fill-box; transform-origin: center; transform: translateX(-28px) scaleX(-1); }
  .janitor-rear-arm { transform-box: fill-box; transform-origin: 15% 12%; animation: janitor-rear-arm-performance 5s ease-in-out both; }
  .janitor-front-arm { transform-box: fill-box; transform-origin: 9% 15%; animation: janitor-front-arm-performance 5s ease-in-out both; }
  .janitor-broom { transform-box: fill-box; transform-origin: 0 0; animation: broom-performance 5s cubic-bezier(.45,.05,.55,.95) both; }
  .broom-handle { fill: none; stroke: #8b5a34; stroke-width: 7; stroke-linecap: round; }
  .broom-collar { fill: #8c9293; stroke: #343c3d; stroke-width: 3; stroke-linejoin: round; }
  .broom-bristles { fill: #d9aa4d; stroke: #57442c; stroke-width: 3; stroke-linejoin: round; }
  .broom-bristle-line { fill: none; stroke: #9b7134; stroke-width: 2; stroke-linecap: round; }
  .janitor-dust-puff { fill: #9b846d; transform-box: fill-box; transform-origin: left bottom; animation: janitor-puffs 5s ease-out both; }
  .janitor-all-clear { position: absolute; left: 50%; top: 50%; display: flex; align-items: center; gap: clamp(9px, 1.2vw, 15px); padding: clamp(13px, 1.7vw, 20px) clamp(20px, 2.8vw, 34px); border: 3px solid #26343c; border-radius: 8px; background: var(--c1); box-shadow: 6px 7px 0 #26343c, 0 18px 32px #0003; color: #222; font: 950 clamp(18px, 2.2vw, 28px)/1 system-ui; letter-spacing: .1em; white-space: nowrap; animation: janitor-sign 5s cubic-bezier(.2,.85,.25,1) both; }
  .janitor-all-clear span { display: grid; width: clamp(28px, 3.2vw, 40px); height: clamp(28px, 3.2vw, 40px); place-items: center; border-radius: 50%; background: #26343c; color: white; font-size: clamp(17px, 2vw, 25px); }
  .dust { left: var(--x); bottom: clamp(76px, 11vh, 112px); color: #796b59; font-size: calc(14px * var(--size)); animation: dust-swept 1.05s var(--delay) ease-out both; }

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
  .poltergeist-vortex { position: absolute; left: 50%; top: 50%; width: min(82vmin, 720px); aspect-ratio: 1; border: 22px double var(--c1); border-radius: 46% 54% 38% 62%; box-shadow: inset 0 0 0 18px var(--c2), inset 0 0 0 40px var(--c3), 0 0 90px var(--c2); mix-blend-mode: difference; animation: poltergeist-vortex 4.8s cubic-bezier(.3,.7,.2,1) both; }
  .poltergeist-eye { position: absolute; z-index: 3; left: 50%; top: 50%; display: grid; width: min(28vmin, 230px); aspect-ratio: 1.7; place-items: center; border: 8px solid var(--c3); border-radius: 65% 35% 64% 36%; background: radial-gradient(circle, #111 0 15%, var(--c1) 16% 30%, white 31% 47%, var(--c2) 49%); box-shadow: 0 0 60px var(--c1); transform: translate(-50%, -50%) rotate(-12deg); animation: possessed-eye 4.5s ease-in-out both; }
  .poltergeist-eye span { color: white; font: 1000 34px/1 system-ui; text-shadow: 0 0 8px #000; }
  .haunted-card { left: 50%; top: 50%; width: 82px; height: 48px; border: 3px solid var(--color); border-radius: 9px; background: color-mix(in srgb, var(--color) 22%, white); box-shadow: 0 12px 30px #0005; color: var(--color); white-space: pre; font: 900 13px/1 ui-monospace, monospace; animation: haunted-orbit 4.8s var(--delay) cubic-bezier(.25,.7,.2,1) both; }
  .impossible-room { position: absolute; left: 50%; top: 50%; width: min(72vmin, 650px); aspect-ratio: 1; transform-style: preserve-3d; animation: impossible-room 5.1s cubic-bezier(.5,-.1,.2,1.12) both; }
  .impossible-floor, .impossible-wall { position: absolute; inset: 12%; border: 9px solid var(--c1); background: repeating-linear-gradient(45deg, color-mix(in srgb, var(--c2) 76%, transparent) 0 18px, color-mix(in srgb, var(--c3) 70%, transparent) 18px 36px); box-shadow: inset 0 0 60px #0005; }
  .impossible-floor { transform: perspective(700px) rotateX(68deg) rotateZ(12deg); }
  .wall-a { transform: perspective(700px) rotateY(73deg) translateX(-28%); }
  .wall-b { transform: perspective(700px) rotateY(-67deg) translateX(30%) rotateZ(90deg); }
  .impossible-room b { position: absolute; z-index: 2; left: 50%; top: 50%; color: white; font: 1000 clamp(16px, 3.5vw, 39px)/.83 system-ui; text-align: center; text-shadow: 3px 3px 0 var(--c1), -3px -3px 0 var(--c2); transform: translate(-50%, -50%) rotate(-9deg); }
  .impossible-room > span { position: absolute; z-index: 3; right: 8%; top: 3%; color: var(--c3); font: 1000 clamp(60px, 12vw, 140px)/1 system-ui; animation: impossible-check 4.6s ease-in-out both; }
  .fever-core { position: absolute; z-index: 2; left: 50%; top: 50%; border: 5px solid var(--c1); padding: 20px; background: var(--c3); color: #111; font: 1000 clamp(15px, 3vw, 32px)/1 system-ui; transform: translate(-50%, -50%); animation: fever-core 5s ease-in-out both; }
  .fever-core div { margin: 12px; border: 4px solid currentColor; padding: 12px; background: var(--c2); transform: rotate(7deg); }
  .fever-core div div { background: var(--c1); transform: rotate(-18deg); }
  .fever-window { left: 50%; top: 50%; width: clamp(110px, 18vw, 220px); min-height: 72px; border: 5px solid var(--color); border-radius: 8px; padding: 12px; background: color-mix(in srgb, var(--color) 25%, #10101a); box-shadow: 0 0 30px var(--color); color: white; white-space: pre-line; font: 900 12px/1.55 ui-monospace, monospace; transform-style: preserve-3d; animation: fever-window 5.2s var(--delay) cubic-bezier(.25,.8,.15,1) both; }
  .overflow-meter { position: absolute; z-index: 3; left: 50%; top: 48%; display: grid; gap: 6px; width: min(70vw, 560px); border: 7px solid var(--c1); padding: 19px; background: #090810e8; box-shadow: 18px 18px 0 var(--c2), -18px -18px 0 var(--c3); color: white; font: 1000 clamp(18px, 4vw, 42px)/1 ui-monospace, monospace; transform: translate(-50%, -50%); animation: overflow-meter 4.6s steps(7, jump-none) both; }
  .overflow-meter b { justify-self: end; color: var(--c3); font-size: 1.7em; }
  .overflow-meter i { height: 20px; background: linear-gradient(90deg, var(--c1), var(--c2), var(--c3)); box-shadow: 0 0 25px var(--c2); transform-origin: left; animation: overflow-fill 3.8s steps(9, end) both; }
  .buffer-slab { left: -8%; top: var(--y); width: 116%; height: 9%; justify-content: center; overflow: hidden; border-block: 2px solid var(--color); background: color-mix(in srgb, var(--color) 28%, transparent); color: white; font: 1000 clamp(10px, 2.2vw, 23px)/1 ui-monospace, monospace; letter-spacing: .12em; mix-blend-mode: screen; animation: buffer-slab 4.5s steps(9, jump-none) both; }
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
  @keyframes aurora { 0%,100%{opacity:0;transform:translateY(25%) skewX(-8deg) scaleY(.4)} 30%,70%{opacity:.75;transform:translateY(-8%) skewX(7deg) scaleY(1.15)} }
  @keyframes float-up { 0%,100%{opacity:0;transform:translateY(70px)} 30%,70%{opacity:1;transform:translateY(0)} }
  @keyframes presence-ripple { 0%{opacity:0;transform:translate(-50%,-50%) scale(.24)} 18%{opacity:.7} 100%{opacity:0;transform:translate(-50%,-50%) scale(4.2)} }
  @keyframes presence-bell { 0%,100%{opacity:0;transform:translate(-50%,-44%) scale(.88)} 17%,78%{opacity:1;transform:translate(-50%,-50%) scale(1)} }
  @keyframes presence-bell-swing { 0%,17%,52%,100%{transform:rotate(0)} 23%{transform:rotate(-8deg)} 29%{transform:rotate(6deg)} 35%{transform:rotate(-3.5deg)} 41%{transform:rotate(2deg)} 47%{transform:rotate(-.7deg)} }
  @keyframes presence-bell-clapper { 0%,18%,54%,100%{transform:rotate(0)} 23%{transform:rotate(18deg)} 29%{transform:rotate(-15deg)} 35%{transform:rotate(10deg)} 41%{transform:rotate(-6deg)} 47%{transform:rotate(2deg)} }
  @keyframes presence-bell-shadow { 0%,100%{opacity:0;transform:scaleX(.72)} 17%,78%{opacity:1;transform:scaleX(1)} }
  @keyframes presence-words { 0%,28%,100%{opacity:0;transform:translate(-50%,12px)} 43%,78%{opacity:1;transform:translate(-50%,0)} }
  @keyframes presence-wash { from{transform:scale(.97)} to{transform:scale(1.035)} }
  @keyframes metta-halo { 0%{opacity:0;transform:translate(-50%,-50%) scale(.45)} 18%{opacity:.72} 100%{opacity:0;transform:translate(-50%,-50%) scale(4.7)} }
  @keyframes metta-heart { 0%,100%{opacity:0;transform:translate(-50%,-50%) scale(.7)} 18%{opacity:1;transform:translate(-50%,-50%) scale(1.06)} 36%,78%{opacity:1;transform:translate(-50%,-50%) scale(1)} 52%{transform:translate(-50%,-50%) scale(1.05)} }
  @keyframes metta-wish { 0%,16%{opacity:0;transform:translate(-50%,-50%) scale(.9)} 33%,73%{opacity:1;transform:translate(calc(-50% + var(--wish-x)),calc(-50% + var(--wish-y))) scale(1)} 100%{opacity:0;transform:translate(calc(-50% + var(--wish-x)),calc(-50% + var(--wish-y))) scale(.96)} }
  @keyframes enough-arrive { 0%,100%{opacity:0;transform:translate(-50%,-45%) scale(.96)} 20%,78%{opacity:1;transform:translate(-50%,-50%) scale(1)} }
  @keyframes enough-flame { from{transform:translateX(-50%) rotate(-2deg) scale(.97)} to{transform:translateX(-50%) rotate(3deg) scale(1.05)} }
  @keyframes seed-flight { 0%{opacity:0;transform:translate(0,40px) scale(var(--scale)) rotate(0)} 12%,70%{opacity:1} 100%{opacity:0;transform:translate(var(--drift),-88vh) scale(.45) rotate(520deg)} }
  @keyframes firefly { to{transform:translate(var(--dx),var(--dy));opacity:.25} }
  @keyframes glass-in { 0%,100%{opacity:0;transform:translateY(90px) rotate(var(--r)) scale(.5)} 25%,72%{opacity:.72;transform:rotate(var(--r)) scale(1)} }
  @keyframes goose-march { 0%{left:-22%} 38%{left:36%} 55%{left:42%;transform:rotate(-4deg)} 100%{left:115%;transform:rotate(2deg)} }
  @keyframes honk { 0%{opacity:0;transform:scale(.2)} 55%{opacity:1;transform:scale(1.3) rotate(-5deg)} 100%{opacity:0} }
  @keyframes janitor-route {
    0%{opacity:0;transform:translateX(0);animation-timing-function:cubic-bezier(.2,.7,.25,1)}
    5%{opacity:1}
    26%,69%{opacity:1;transform:translateX(calc(50vw + 105px))}
    70%{transform:translateX(calc(50vw + 105px));animation-timing-function:cubic-bezier(.55,0,.85,.45)}
    84%{opacity:1}
    96%{opacity:.08}
    100%{opacity:0;transform:translateX(calc(100vw + 55px))}
  }
  @keyframes janitor-performance {
    0%,5%,10%,15%,20%,26%,69%,74%,79%,84%,89%,94%,100%{transform:translateY(0) rotate(0)}
    3%,8%,13%,18%,23%,72%,77%,82%,87%,92%{transform:translateY(3px) rotate(.8deg)}
    34%,45%,56%,65%{transform:translateY(3px) rotate(2.5deg)}
    39%,50%,61%{transform:translateY(1px) rotate(-1deg)}
  }
  @keyframes janitor-shadow {
    0%,10%,20%,26%,34%,45%,56%,65%,69%,79%,89%,100%{transform:scaleX(1);opacity:1}
    5%,15%,23%,39%,50%,61%,74%,84%,94%{transform:scaleX(.9);opacity:.68}
  }
  @keyframes janitor-head-performance {
    0%,26%,69%,100%{transform:rotate(0)}
    30%,65%{transform:rotate(5deg)}
    34%,45%,56%{transform:rotate(8deg)}
    39%,50%,61%{transform:rotate(3deg)}
  }
  @keyframes janitor-back-step { 0%,10%,20%,26%,69%,79%,89%,100%{transform:rotate(8deg)} 5%,15%,23%,74%,84%,94%{transform:rotate(-8deg)} 27%,68%{transform:rotate(0)} }
  @keyframes janitor-front-step { 0%,10%,20%,26%,69%,79%,89%,100%{transform:rotate(-8deg)} 5%,15%,23%,74%,84%,94%{transform:rotate(8deg)} 27%,68%{transform:rotate(0)} }
  @keyframes janitor-rear-arm-performance { 0%,26%,69%,100%{transform:rotate(0)} 34%,45%,56%,65%{transform:rotate(-5deg)} 39%,50%,61%{transform:rotate(6deg)} }
  @keyframes janitor-front-arm-performance { 0%,26%,69%,100%{transform:rotate(0)} 34%,45%,56%,65%{transform:rotate(-6deg)} 39%,50%,61%{transform:rotate(7deg)} }
  @keyframes broom-performance { 0%,27%,69%,100%{transform:rotate(0)} 34%,45%,56%,65%{transform:rotate(-14deg)} 39%,50%,61%{transform:rotate(16deg)} }
  @keyframes janitor-puffs {
    0%,33%,40%,44%,51%,55%,62%,64%,70%,100%{opacity:0;transform:translate(0,0) scale(.4)}
    36%,47%,58%,67%{opacity:.85;transform:translate(8px,-5px) scale(.9)}
    39%,50%,61%,69%{opacity:0;transform:translate(22px,-16px) scale(1.45)}
  }
  @keyframes janitor-sign {
    0%,76%{opacity:0;transform:translate(-50%,-75%) rotate(-12deg) scale(.72)}
    83%{opacity:1;transform:translate(-50%,-46%) rotate(2deg) scale(1.08)}
    88%,97%{opacity:1;transform:translate(-50%,-50%) rotate(-3deg) scale(1)}
    100%{opacity:0;transform:translate(-50%,-47%) rotate(-3deg) scale(.98)}
  }
  @keyframes dust-swept { 0%,12%{opacity:1;transform:translate(0,0) rotate(0) scale(1)} 62%{opacity:.8;transform:translate(24px,-9px) rotate(150deg) scale(.75)} 100%{opacity:0;transform:translate(55px,-3px) rotate(260deg) scale(.15)} }
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
  @keyframes poltergeist-vortex { 0%,100%{opacity:0;transform:translate(-50%,-50%) rotate(0) scale(.1);border-radius:50%} 20%{opacity:.75} 52%{opacity:.9;transform:translate(-50%,-50%) rotate(410deg) scale(1.15);border-radius:28% 72% 62% 38%} 78%{transform:translate(-50%,-50%) rotate(-130deg) scale(.72);border-radius:73% 27% 31% 69%} }
  @keyframes possessed-eye { 0%,100%{opacity:0;transform:translate(-50%,-50%) rotate(-80deg) scale(.2)} 24%{opacity:1;transform:translate(-50%,-50%) rotate(15deg) scale(1.15)} 48%{transform:translate(-50%,-50%) rotate(-18deg) scale(.82)} 70%{transform:translate(-50%,-50%) rotate(190deg) scale(1.4)} }
  @keyframes haunted-orbit { 0%,100%{opacity:0;transform:translate(-50%,-50%) rotate(var(--angle)) translateX(0) rotate(calc(var(--angle) * -1)) scale(.1)} 16%{opacity:.95} 42%{transform:translate(-50%,-50%) rotate(calc(var(--angle) + 290deg)) translateX(var(--radius)) rotate(calc((var(--angle) + 290deg) * -1)) scale(1.25)} 68%{transform:translate(-50%,-50%) rotate(calc(var(--angle) - 190deg)) translateX(var(--radius-mid)) rotate(calc((var(--angle) - 190deg) * -1)) scale(.65)} 82%{opacity:1;transform:translate(-50%,-50%) rotate(calc(var(--angle) + 540deg)) translateX(var(--radius-wide)) rotate(calc((var(--angle) + 540deg) * -1)) scale(1)} }
  @keyframes impossible-room { 0%,100%{opacity:0;transform:translate(-50%,-50%) perspective(800px) rotateX(0) rotateY(0) scale(.25)} 18%{opacity:.9} 38%{transform:translate(-50%,-50%) perspective(800px) rotateX(48deg) rotateY(-38deg) rotateZ(12deg) scale(1.05)} 66%{transform:translate(-50%,-50%) perspective(800px) rotateX(-34deg) rotateY(118deg) rotateZ(-19deg) scale(.82)} 82%{opacity:1;transform:translate(-50%,-50%) perspective(800px) rotateX(72deg) rotateY(205deg) scale(1.18)} }
  @keyframes impossible-check { 0%,100%{opacity:0;transform:translate(-40vw,55vh) rotate(-180deg) scale(.2)} 34%{opacity:1;transform:translate(0,0) rotate(22deg) scale(1)} 63%{transform:translate(-52vw,-20vh) rotate(320deg) scale(1.8)} 80%{transform:translate(-8vw,22vh) rotate(600deg) scale(.7)} }
  @keyframes fever-core { 0%,100%{opacity:0;transform:translate(-50%,-50%) scale(.05) rotate(-40deg)} 25%{opacity:1;transform:translate(-50%,-50%) scale(1.18) rotate(8deg)} 51%{transform:translate(-50%,-50%) scale(.72) rotate(-11deg)} 76%{opacity:1;transform:translate(-50%,-50%) scale(1.45) rotate(19deg)} }
  @keyframes fever-window { 0%,100%{opacity:0;transform:translate(-50%,-50%) translateZ(0) rotate(0) scale(.05)} 18%{opacity:.9} 38%{transform:translate(-50%,-50%) translateZ(var(--depth)) rotate(var(--turn)) translateX(var(--x)) scale(.85)} 64%{transform:translate(-50%,-50%) translateZ(calc(var(--depth) * -1)) rotate(calc(var(--turn) * -1)) translateY(var(--y)) scale(1.2)} 82%{opacity:.95;transform:translate(-50%,-50%) translateZ(var(--depth)) rotate(calc(var(--turn) + 270deg)) scale(.55)} }
  @keyframes overflow-meter { 0%,100%{opacity:0;transform:translate(-50%,-50%) scaleX(.1) skewX(-22deg)} 16%{opacity:1;transform:translate(-44%,-52%) scaleX(1.2) skewX(8deg)} 39%{transform:translate(-55%,-44%) scale(.8,1.35) skewY(-6deg)} 62%{transform:translate(-48%,-57%) scale(1.28,.74) skewX(13deg)} 82%{opacity:1;transform:translate(-50%,-50%) scale(.95) skew(0)} }
  @keyframes overflow-fill { 0%{transform:scaleX(.03)} 55%{transform:scaleX(.82)} 72%,100%{transform:scaleX(1.37)} }
  @keyframes buffer-slab { 0%,100%{opacity:0;transform:translateX(0) skewX(0)} 12%{opacity:.75} 27%{transform:translateX(var(--shift-a)) skewX(12deg)} 49%{transform:translateX(var(--shift-b)) skewX(-18deg) scaleY(1.55)} 68%{transform:translateX(var(--shift-c)) skewX(25deg) scaleY(.55)} 85%{opacity:.85;transform:translateX(var(--shift-d))} }
  @keyframes marquee-bow { 0%,100%{opacity:0;transform:translateY(-60px)} 22%,70%{opacity:1;transform:translateY(0) scaleX(1)} 48%{transform:translateY(9px) scaleX(.95)} }
  @keyframes completed-list-pop { 0%{opacity:0;transform:translate(-50%,-42%) rotate(-9deg) scale(.48)} 18%{opacity:1;transform:translate(-50%,-50%) rotate(3deg) scale(1.12)} 31%,76%{opacity:1;transform:translate(-50%,-50%)} 100%{opacity:0;transform:translate(-50%,-62%) rotate(2deg) scale(.94)} }
  @keyframes completed-row-check { from{opacity:0;transform:translateX(-12px) scale(.92)} to{opacity:1;transform:none} }
  @keyframes check-spark-burst { 0%{opacity:0;transform:translate(-50%,-50%) rotate(-20deg) scale(.15)} 18%{opacity:1} 72%{opacity:1;transform:translate(calc(-50% + var(--check-x)),calc(-50% + var(--check-y))) rotate(8deg)} 100%{opacity:0;transform:translate(calc(-50% + var(--check-x)),calc(-50% + var(--check-y))) rotate(18deg) scale(.72)} }

  @supports not (color: color-mix(in srgb, white, black)) {
    .effect-wash { background: radial-gradient(circle, rgba(120,120,220,.25), transparent 58%); }
  }
  @media (prefers-reduced-motion: reduce) {
    .celebration-stage *, .celebration-banner, .list-celebration { animation: none !important; }
    .list-celebration { display: none; }
    .effect-wash { opacity: .12; }
  }
</style>
