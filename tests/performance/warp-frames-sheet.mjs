// Lays captured warp frames from two builds side by side in one labelled image.
// Usage: node warp-frames-sheet.mjs <baseline dir> <candidate dir> <output.png> <title>
import { chromium } from '@playwright/test'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const [baseline, candidate, output, title] = process.argv.slice(2)
const frames = (await readdir(baseline)).filter((name) => name.endsWith('.png')).sort()
const image = async (dir, name) => `data:image/png;base64,${(await readFile(join(dir, name))).toString('base64')}`
const rows = []
for (const name of frames) {
  rows.push(`<tr><th>${Number.parseInt(name, 10)} ms</th><td><img src="${await image(baseline, name)}"></td><td><img src="${await image(candidate, name)}"></td></tr>`)
}
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
await page.setContent(`<style>
  body { font: 15px system-ui; margin: 16px; background: #fff; color: #111 }
  h1 { font-size: 20px; margin: 0 0 4px } p { margin: 0 0 12px; color: #444 }
  th { text-align: right; padding-right: 8px; white-space: nowrap } td img { width: 700px; display: block }
</style><h1>${title}</h1>
<p>Same timing, turn and duration in both columns; the noise pattern itself is random per card in both, so shapes differ but the kind and strength of the warp should match.</p>
<table><tr><th></th><th>Before</th><th>After</th></tr>${rows.join('')}</table>`)
await page.screenshot({ path: output, fullPage: true })
await browser.close()
