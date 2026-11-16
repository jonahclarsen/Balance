import { expect, test } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openView } from '../helpers/navigation'

test('profile sorting with synthetic idea trees under CPU throttling', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'CDP metrics require Chromium')
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await expect(page.getByRole('region', { name: 'Daily plan' })).toBeVisible()
  await page.evaluate(async () => {
    const path = '/src/lib/store.ts'
    const { plannerStore } = await import(/* @vite-ignore */ path)
    for (let i = 0; i < 8; i++) {
      const parent = plannerStore.addIdea(`Synthetic profile idea ${i}`)
      for (let j = 0; j < 8; j++) {
        const child = plannerStore.addIdea(`Synthetic checklist entry ${i}-${j}`)
        plannerStore.moveIdeaItem('bucket_proposition', child, parent, 'inside')
      }
    }
  })
  await openView(page, 'Ideas')
  await page.locator('.ideas-panel').getByRole('button', { name: 'Sort', exact: true }).click()
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable')
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
  const samples: Record<string, number>[] = []
  for (let round = 0; round < 7; round++) {
    await page.keyboard.press('n')
    const before = await cdp.send('Performance.getMetrics')
    const frame = await page.evaluate(async () => {
      const deltas: number[] = []
      let previous = performance.now()
      let running = true
      function measure(now: number) {
        deltas.push(now - previous)
        previous = now
        if (running) requestAnimationFrame(measure)
      }
      requestAnimationFrame(measure)
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 't', bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 250))
      const nodes = document.querySelector('.refinement')?.querySelectorAll('*').length ?? 0
      await new Promise((resolve) => setTimeout(resolve, 1200))
      running = false
      const ordered = deltas.sort((a, b) => a - b)
      return { nodes, frames: deltas.length, frameP95Ms: ordered[Math.floor(ordered.length * .95)] ?? 0,
        slowFrames: deltas.filter((delta) => delta > 34).length }
    })
    expect(frame.nodes).toBeGreaterThan(0)
    const after = await cdp.send('Performance.getMetrics')
    const metrics = Object.fromEntries(after.metrics.map(({ name, value }) => [name, value]))
    const previous = Object.fromEntries(before.metrics.map(({ name, value }) => [name, value]))
    const sample: Record<string, number> = { ...frame }
    for (const name of ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration']) {
      sample[`${name}Ms`] = (metrics[name]! - previous[name]!) * 1000
    }
    // Warm up the font, canvas/SVG pipelines and editor code before measurement.
    if (round > 0) samples.push(sample)
    await expect(page.locator('.refinement')).toHaveCount(0)
    await expect(page.locator('.idea-sort[role="dialog"]')).toBeVisible()
  }
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
  const output = process.env.IDEA_PROFILE_DIR ?? 'artifacts/idea-refinement-profile'
  mkdirSync(output, { recursive: true })
  const variant = process.env.IDEA_PROFILE_VARIANT ?? 'local'
  writeFileSync(join(output, `${variant}.json`), JSON.stringify({ variant, samples }, null, 2))
  console.log(JSON.stringify({ variant, samples }))
})
