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
  const keyboard=await page.evaluate(() => {
    const received:string[]=[]
    document.addEventListener('keydown',event => received.push(event.key))
    const shortcuts:KeyboardEventInit[]=[
      {key:'PageUp',ctrlKey:true,shiftKey:true},
      {key:'PageDown',ctrlKey:true,shiftKey:true},
      {key:'ArrowLeft',metaKey:true,shiftKey:true},
      {key:'ArrowRight',metaKey:true,shiftKey:true},
      {key:'ArrowLeft',altKey:true,shiftKey:true},
      {key:'ArrowRight',altKey:true,shiftKey:true},
      {key:'k'},
    ]
    const allowed=shortcuts.map(shortcut => document.documentElement.dispatchEvent(
      new KeyboardEvent('keydown',{...shortcut,bubbles:true,cancelable:true,composed:true}),
    ))
    // Events from the warning's quiz links must still reach their controls.
    const gateAllowed=document.querySelector('#balance-situate-gate')!.dispatchEvent(
      new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,composed:true}),
    )
    return {allowed,received,gateAllowed}
  })
  expect(keyboard).toEqual({allowed:[true,true,true,true,true,true,false],received:['Enter'],gateAllowed:true})
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

test('Discord threads report their parent channel from the sidebar', async ({page}) => {
  await page.goto('/')
  await page.setContent(`<ul aria-label="Channels">
    <li><div data-list-item-id="channels___100"><a href="/channels/1/100">category</a></div></li>
    <li><div data-list-item-id="channels___200"><a href="/channels/1/200">nested parent</a></div>
      <ul role="group"><li><div data-list-item-id="channels___201"><a href="/channels/1/201">thread</a></div></li></ul></li>
    <li><div data-list-item-id="channels___300"><a href="/channels/1/300">sibling parent</a></div></li>
    <ul role="group"><li><div data-list-item-id="channels___301"><a href="/channels/1/301">thread</a></div></li></ul>
  </ul>`)
  await page.addScriptTag({path:resolve('integrations/situate/chrome/discord.js')})
  const parents=await page.evaluate(() => {
    const parent=(window as unknown as {situateDiscordParent:(d:Document,id:string)=>string}).situateDiscordParent
    return ['201','301','200','999'].map(id => parent(document,id))
  })
  expect(parents).toEqual(['200','300','',''])
})
