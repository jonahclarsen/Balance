import {expect, test} from '@playwright/test'
import {openView} from '../helpers/navigation'

test('freeze report export bypasses database diagnostics and event recording never sends editor values', async ({page}) => {
  await page.clock.install({time: new Date('2025-01-15T12:00:00Z')})
  await page.addInitScript(() => {
    const runtime = window as any
    runtime.isTauri = true
    runtime.__freezeCalls = []
    runtime.__databaseCalls = []
    runtime.__TAURI_EVENT_PLUGIN_INTERNALS__ = {unregisterListener: () => undefined}
    runtime.__TAURI_INTERNALS__ = {
      metadata: {currentWindow: {label:'main'}, currentWebview:{label:'main'}},
      transformCallback: () => 1,
      invoke: async (command: string, args: any) => {
        if (command.includes('freeze')) runtime.__freezeCalls.push({command,args})
        else runtime.__databaseCalls.push(command)
        switch (command) {
          case 'get_recovery_key_status': return {confirmed:true, recoveryKey:null,databasePath:'/tmp/synthetic.sqlite3'}
          case 'get_sync_settings': return {enabled:false,pairingCode:null,relayUrl:''}
          case 'pending_deep_links': return []
          case 'get_export_settings': return {exportDirectory:'/tmp',defaultExportDirectory:'/tmp',usesDefaultExportDirectory:true}
          case 'get_database_maintenance_status': return {due:false}
          case 'build_info': return {version:'test',commit:'test'}
          case 'share_freeze_diagnostics': return 'Report prepared. Choose an app to share it.'
          default: return null
        }
      },
    }
  })
  await page.goto('/')
  await openView(page, 'Settings')
  // Finish startup timers and hold unrelated background work while measuring
  // the report action. A database call made by export still increments the spy.
  await page.clock.pauseAt(new Date('2025-01-15T12:01:00Z'))
  await page.evaluate(() => {
    const input = document.createElement('textarea')
    input.value = 'synthetic private task and recovery key'
    document.body.append(input)
    input.focus()
    input.dispatchEvent(new CompositionEvent('compositionstart', {bubbles:true,data:'synthetic private composition'}))
    window.dispatchEvent(new ErrorEvent('error', {message:'synthetic private error'}))
  })
  await expect.poll(() => page.evaluate(() => (window as any).__freezeCalls.filter((c:any) => c.command==='record_freeze_diagnostic').length)).toBeGreaterThan(1)
  // Drain saves queued by setup before measuring the report export itself.
  await page.evaluate(async () => {
    const storePath = '/src/lib/store.ts'
    const {plannerStore} = await import(/* @vite-ignore */ storePath)
    await plannerStore.flushPendingOperations()
  })
  await page.clock.runFor(3000)
  const prior = await page.evaluate(() => (window as any).__databaseCalls.length)
  await page.getByRole('button', {name:'Export freeze report',exact:true}).click()
  await expect(page.getByText('Report prepared. Choose an app to share it.', {exact:true})).toBeVisible()
  await page.clock.runFor(1000)
  const data = await page.evaluate(() => ({calls:(window as any).__freezeCalls, databaseCalls:(window as any).__databaseCalls, after:(window as any).__databaseCalls.length}))
  expect(JSON.stringify(data.calls)).not.toContain('synthetic private')
  expect(data.calls.some((c:any) => c.args?.event?.event==='javascript_error')).toBe(true)
  expect(data.calls.some((c:any) => c.command==='share_freeze_diagnostics')).toBe(true)
  expect(data.after, JSON.stringify(data.databaseCalls.slice(prior))).toBe(prior)
})
