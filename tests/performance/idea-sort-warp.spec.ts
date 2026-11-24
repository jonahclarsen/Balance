import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

// Profiles the warp between cards in the idea sorter, and captures frames of it
// at fixed times so two builds can be compared pixel for pixel.

const NOW = new Date('2026-10-08T18:00:00Z')
const WARPS = Number(process.env.BALANCE_WARP_COUNT ?? 12)
const WINDOW_MS = 650
const VARIANT = process.env.BALANCE_WARP_VARIANT ?? 'full'
const CAPTURE_DIR = process.env.BALANCE_WARP_CAPTURE_DIR
const CAPTURE_TIMES = [16, 32, 48, 64, 96, 128, 176, 240, 320, 400]

test.use({ timezoneId: 'America/Vancouver' })

const IDEAS = Array.from({ length: WARPS + 2 }, (_, index) =>
  `Synthetic idea ${index}: try a slower morning routine with a walk before checking messages, then note how it feels`)

// "no-filter" measures the warp's motion alone; "full" is what ships.
const VARIANT_STYLES: Record<string, string> = {
  'no-filter': '.idea-sort-card { filter: none !important; }',
}

// CPU seconds used by every browser process, so raster, GPU and compositor
// work count as well as the page's main thread.
function browserCpuMs() {
  const output = execFileSync('ps', ['-axo', 'time=,command='], { encoding: 'utf8' })
  let total = 0
  for (const line of output.split('\n')) {
    const match = line.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)\s+(.*)$/)
    if (!match || !match[5]!.includes('ms-playwright')) continue
    const [, days, hours, minutes, seconds] = match
    total += ((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60 + Number(seconds)
  }
  return total * 1000
}

async function openSorter(page: Page) {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await expect(page.getByRole('region', { name: 'Daily plan' })).toBeVisible()
  await page.evaluate(async (ideas) => {
    const path = '/src/lib/store.ts'
    const { plannerStore } = await import(/* @vite-ignore */ path)
    for (const idea of ideas) plannerStore.addIdea(idea)
  }, IDEAS)
  if (VARIANT_STYLES[VARIANT]) await page.addStyleTag({ content: VARIANT_STYLES[VARIANT] })
  await page.keyboard.press('ControlOrMeta+Shift+D')
  await expect(page.locator('.idea-sort[role="dialog"] .idea-sort-card')).toHaveCount(1)
  // Let the dev server finish loading modules before the first warp.
  await page.waitForTimeout(1500)
}

test('profiles the warp between idea cards', async ({ page, browserName }, testInfo) => {
  test.skip(Boolean(CAPTURE_DIR), 'Capture run')
  await page.clock.setFixedTime(NOW)
  if (VARIANT !== 'full' && !VARIANT_STYLES[VARIANT]) throw new Error(`Unknown variant ${VARIANT}`)
  if (testInfo.project.name.includes('6x-cpu')) {
    const session = await page.context().newCDPSession(page)
    await session.send('Emulation.setCPUThrottlingRate', { rate: 6 })
  }
  await openSorter(page)

  const session = browserName === 'chromium' ? await page.context().newCDPSession(page) : null
  const metrics = async () => {
    if (!session) return new Map<string, number>()
    const result = await session.send('Performance.getMetrics') as { metrics: Array<{ name: string; value: number }> }
    return new Map(result.metrics.map(({ name, value }) => [name, value]))
  }
  await session?.send('Performance.enable')

  const warps: Array<{ dispatchMs: number; firstFrameMs: number; intervals: number[] }> = []
  let rendererMs = 0
  let elapsedMs = 0
  let browserMs = 0
  let wallMs = 0
  for (let warp = 0; warp < WARPS; warp += 1) {
    const before = await metrics()
    const cpuBefore = browserCpuMs()
    const wallBefore = performance.now()
    const result = await page.evaluate(async (windowMs) => {
      const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve))
      const press = (key: string) => window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
      await frame()
      press('n')
      await frame()
      await frame()
      const started = performance.now()
      press('t')
      const dispatchMs = performance.now() - started
      const intervals: number[] = []
      let previous = await frame()
      const firstFrameMs = previous - started
      while (previous - started < windowMs) {
        const now = await frame()
        intervals.push(now - previous)
        previous = now
      }
      return { dispatchMs, firstFrameMs, intervals }
    }, WINDOW_MS)
    browserMs += browserCpuMs() - cpuBefore
    wallMs += performance.now() - wallBefore
    const after = await metrics()
    rendererMs += ((after.get('TaskDuration') ?? 0) - (before.get('TaskDuration') ?? 0)) * 1000
    elapsedMs += ((after.get('Timestamp') ?? 0) - (before.get('Timestamp') ?? 0)) * 1000
    warps.push(result)
  }
  await session?.detach()

  const intervals = warps.flatMap(({ intervals }) => intervals).sort((a, b) => a - b)
  const pick = (values: number[], fraction: number) => values[Math.min(values.length - 1, Math.floor(values.length * fraction))] ?? 0
  const sortedBy = (key: 'dispatchMs' | 'firstFrameMs') => warps.map((warp) => warp[key]).sort((a, b) => a - b)
  const profile = {
    browser: browserName,
    project: testInfo.project.name,
    variant: VARIANT,
    warps: warps.length,
    framesPerWarp: intervals.length / warps.length,
    frameMs: { p50: pick(intervals, .5), p90: pick(intervals, .9), max: intervals.at(-1) ?? 0 },
    longFrames: intervals.filter((value) => value > 34).length / warps.length,
    dispatchMs: { p50: pick(sortedBy('dispatchMs'), .5), max: sortedBy('dispatchMs').at(-1) },
    firstFrameMs: { p50: pick(sortedBy('firstFrameMs'), .5), max: sortedBy('firstFrameMs').at(-1) },
    browserCpuMsPerWarp: browserMs / warps.length,
    browserCpuPercent: browserMs / wallMs * 100,
    rendererUtilizationPercent: elapsedMs > 0 ? rendererMs / elapsedMs * 100 : null,
  }
  console.log(`IDEA_SORT_WARP ${JSON.stringify(profile)}`)
})

// Freezes time, seeds randomness and pauses the card's motion so every build
// draws the warp at the same instants.
test('captures warp frames at fixed times', async ({ page, browserName }) => {
  test.skip(!CAPTURE_DIR, 'Profile run')
  await page.addInitScript(() => {
    let seed = 1234567
    Math.random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    const animate = Element.prototype.animate
    const running: Animation[] = []
    ;(window as any).__warpAnimations = running
    Element.prototype.animate = function (...args) {
      const animation = animate.apply(this, args as any)
      animation.pause()
      animation.currentTime = 0
      running.push(animation)
      return animation
    }
  })
  await page.clock.setFixedTime(NOW)
  await openSorter(page)
  const card = page.locator('.idea-sort-card')
  // From here frames run only when the test advances time.
  await page.evaluate(() => {
    let now = performance.now()
    let pending: Array<[number, FrameRequestCallback]> = []
    let next = 1
    performance.now = () => now
    window.requestAnimationFrame = (callback) => { pending.push([next, callback]); return next++ }
    window.cancelAnimationFrame = (id) => { pending = pending.filter(([handle]) => handle !== id) }
    ;(window as any).__advance = (ms: number) => {
      const end = now + ms
      while (now < end) {
        now = Math.min(end, now + 16)
        const due = pending
        pending = []
        for (const [, callback] of due) callback(now)
      }
    }
  })
  await page.keyboard.press('n')
  await page.keyboard.press('t')
  await expect(card).toContainText('Synthetic idea 1')
  const box = (await page.locator('.idea-sort .paste-review-list').boundingBox())!
  const clip = { x: Math.max(0, box.x - 40), y: Math.max(0, box.y - 40), width: box.width + 80, height: box.height + 80 }
  const directory = join(CAPTURE_DIR!, browserName)
  await mkdir(directory, { recursive: true })
  let elapsed = 0
  for (const time of CAPTURE_TIMES) {
    const step = time - elapsed
    elapsed = time
    await page.evaluate(({ time, step }) => {
      ;(window as any).__advance(step)
      for (const animation of (window as any).__warpAnimations as Animation[]) {
        if (animation.playState !== 'finished') animation.currentTime = time
      }
    }, { time, step })
    await page.screenshot({ path: join(directory, `${String(time).padStart(3, '0')}.png`), clip, animations: 'allow' })
  }
})
