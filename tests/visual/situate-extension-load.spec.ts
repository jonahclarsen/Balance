import { test, expect, chromium } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

test('unpacked Situate extension keeps its ID and gates an actual browser tab', async ({},testInfo) => {
  test.skip(testInfo.project.name !== 'desktop','Chrome extension loading is Chromium-only')
  const directory=resolve('integrations/situate/chrome')
  const manifest=JSON.parse(await readFile(resolve(directory,'manifest.json'),'utf8'))
  const digest=createHash('sha256').update(Buffer.from(manifest.key,'base64')).digest().subarray(0,16)
  const id=[...digest].flatMap(byte=>[byte>>4,byte&15]).map(n=>String.fromCharCode(97+n)).join('')
  const context=await chromium.launchPersistentContext('',{channel:'chromium',headless:true,args:[`--disable-extensions-except=${directory}`,`--load-extension=${directory}`]})
  try {
    const worker=context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker')
    expect(new URL(worker.url()).host).toBe(id)
    const status={version:1,enabled:true,refreshAt:Date.now()+600000,modes:[{id:'touch-grass',name:'Touch grass',active:true,targets:[{id:'fixture',kind:'domain',category:'ai',value:'situate.test'}]}]}
    // Override only the transport in this disposable extension worker. No installed host or user status is read.
    await worker.evaluate(value=>{
      const api=(globalThis as unknown as {chrome:{runtime:{sendNativeMessage:()=>Promise<unknown>}}}).chrome
      api.runtime.sendNativeMessage=async()=>value
    },status)
    const page=await context.newPage()
    await page.route('https://situate.test/**',route=>route.fulfill({contentType:'text/html',body:'<h1>Synthetic private chat</h1>'}))
    await page.goto('https://situate.test/chat')
    await expect(page.locator('#balance-situate-gate')).toBeVisible()
    await expect(page.getByRole('heading',{name:'Synthetic private chat'})).toBeHidden()
    status.modes[0].active=false;status.modes[0].targets=[]
    await worker.evaluate(value=>{
      const api=(globalThis as unknown as {chrome:{runtime:{sendNativeMessage:()=>Promise<unknown>}}}).chrome
      api.runtime.sendNativeMessage=async()=>value
    },status)
    await expect(page.locator('#balance-situate-gate')).toHaveCount(0)
    await expect(page.getByRole('heading',{name:'Synthetic private chat'})).toBeVisible()
  } finally { await context.close() }
})
