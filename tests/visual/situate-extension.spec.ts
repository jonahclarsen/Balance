import { test, expect } from '@playwright/test'
import { resolve } from 'node:path'
test('extension hides blocked content and restores it after a pass without reading messages', async ({page}) => {
  await page.goto('/')
  await page.setContent('<style>body{display:block}h1{visibility:visible!important}</style><main><h1>Synthetic private content</h1><button>Underlying control</button></main>')
  await page.evaluate(() => {
    const testWindow=window as unknown as { chrome:object; situateBlocked:boolean }
    testWindow.situateBlocked=true
    testWindow.chrome={runtime:{sendMessage:async()=>({ready:true,blocked:testWindow.situateBlocked ? [{mode:'touch-grass',name:'Touch grass',target:''}] : []})}}
  })
  await page.addScriptTag({path:resolve('integrations/situate/chrome/content.js')})
  await expect(page.locator('#balance-situate-gate')).toBeVisible()
  await expect(page.getByRole('heading',{name:'Synthetic private content'})).toBeHidden()
  await expect(page.locator('body')).toHaveAttribute('inert','')
  await expect(page.locator('body')).toHaveCSS('display','none')
  await page.evaluate(() => {
    const body=document.createElement('body')
    body.innerHTML='<h1>Synthetic private content</h1><button>Replacement control</button>'
    document.body.replaceWith(body)
  })
  await expect(page.locator('body')).toHaveAttribute('inert','')
  await expect(page.getByRole('heading',{name:'Synthetic private content'})).toBeHidden()
  await page.evaluate(() => { (window as unknown as {situateBlocked:boolean}).situateBlocked=false })
  await expect(page.locator('#balance-situate-gate')).toHaveCount(0)
  await expect(page.getByRole('heading',{name:'Synthetic private content'})).toBeVisible()
  await expect(page.locator('body')).not.toHaveAttribute('inert','')
  await expect(page.locator('body')).toHaveCSS('display','block')
})
