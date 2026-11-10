import { expect, test } from '@playwright/test'
import { openNoteList, closeNoteList, openView } from '../helpers/navigation'
import { createScreenshotState } from '../../website/capture/seed'

test('System 1 notes distinguish headings and center every formatting icon', async ({ page }, testInfo) => {
  await page.goto('/')
  await page.evaluate(state => {
    localStorage.clear()
    localStorage.setItem('balance.appState.v1', JSON.stringify(state))
    localStorage.setItem('balance:deviceAppearance.v1', JSON.stringify({ version: 1, themeId: 'system1', colorScheme: 'light' }))
  }, createScreenshotState('2026-10-14'))
  await page.reload()
  await openView(page, 'Notes')
  await openNoteList(page)
  await page.locator('.note-card').filter({ hasText: 'Camping' }).click()
  await closeNoteList(page)
  await page.evaluate(() => document.fonts.ready)
  const body = page.locator('.lexical-note-editor [data-kind="paragraph"] .note-text').first()
  const heading = page.locator('.lexical-note-editor .note-heading .note-text').first()
  expect(await heading.evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThan(await body.evaluate(el => parseFloat(getComputedStyle(el).fontSize)))
  for (const button of await page.locator('.note-format-group button').all()) {
    const centered = await button.evaluate(el => {
      const box = el.getBoundingClientRect()
      const icon = el.querySelector('svg')!.getBoundingClientRect()
      return Math.abs(box.x + box.width / 2 - icon.x - icon.width / 2) < 1
        && Math.abs(box.y + box.height / 2 - icon.y - icon.height / 2) < 1
    })
    expect(centered).toBe(true)
  }
  await page.screenshot({ path: testInfo.outputPath('system1-notes.png') })
})

for (const themeId of ['system1', 'windowsxp', 'windowsvista', 'graphite']) {
  test(`${themeId} uses native hover labels only outside old OS themes`, async ({ page }) => {
    await page.goto('/')
    await page.evaluate(themeId => {
      localStorage.setItem('balance:deviceAppearance.v1', JSON.stringify({ version: 1, themeId, colorScheme: 'light' }))
    }, themeId)
    await page.reload()
    // Synthetic icon control exercises inherited titles and title-only naming.
    await page.evaluate(() => {
      const parent = document.createElement('div')
      parent.title = 'Parent label'
      const button = document.createElement('button')
      button.id = 'tooltip-fixture'
      button.title = 'Fixture action'
      button.style.cssText = 'position:fixed;left:100px;top:200px;width:40px;height:40px;z-index:99999'
      parent.append(button)
      document.body.append(parent)
    })
    const button = page.locator('#tooltip-fixture')
    await button.hover()
    await expect(button).toHaveAttribute('title', themeId === 'graphite' ? 'Fixture action' : '')
    await expect(button).toHaveAccessibleName('Fixture action')
    await expect(button.locator('..')).toHaveAttribute('title', themeId === 'graphite' ? 'Parent label' : '')
    await page.mouse.move(0, 0)
    await expect(button).toHaveAttribute('title', 'Fixture action')
    await expect(button.locator('..')).toHaveAttribute('title', 'Parent label')
  })
}

for (const [id, name] of [['system1', 'Mac System 1'], ['windowsxp', 'Windows XP'], ['windowsvista', 'Windows Vista']] as const) {
  test(`${name} can be selected, survives reload, and stays usable in both appearances`, async ({ page, browserName, isMobile }, testInfo) => {
    // Dozens of full-page screenshots in both appearances outlast the default budget on CI.
    test.slow()
    await page.clock.install({ time: new Date('2026-10-14T14:20:00') })
    await page.emulateMedia({ colorScheme: 'light' })
    await page.goto('/')
    await page.evaluate(state => {
      localStorage.clear()
      localStorage.setItem('balance.appState.v1', JSON.stringify(state))
      localStorage.setItem('balance:deviceAppearance.v1', JSON.stringify({ version: 1, themeId: 'graphite', colorScheme: 'system' }))
    }, createScreenshotState('2026-10-14'))
    await page.reload()
    await openView(page, 'Settings')
    await page.getByRole('group', { name: 'Color theme', exact: true }).getByRole('button', { name: new RegExp(`^${name} `) }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', id)
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-theme', id)
    if (!isMobile && browserName === 'chromium' && id !== 'system1') {
      await page.evaluate(() => document.fonts.ready)
      const cdp = await page.context().newCDPSession(page)
      await cdp.send('DOM.enable')
      await cdp.send('CSS.enable')
      const { root } = await cdp.send('DOM.getDocument')
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '.sidebar .nav-label' })
      const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId })
      await testInfo.attach('rendered-sidebar-fonts', { body: JSON.stringify(fonts), contentType: 'application/json' })
      const expected = id === 'windowsvista' ? /Segoe UI|Selawik/i : /Tahoma|Verdana/i
      expect(fonts.some(font => expected.test(font.familyName) && font.glyphCount > 0)).toBe(true)
      await cdp.detach()
    }
    await openView(page, 'Today')
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      await expect(page.locator('html')).toHaveAttribute('data-color-scheme', scheme)
      await expect(page.getByRole('navigation', { name: 'Primary', exact: true }).or(page.getByRole('button', { name: 'Open navigation', exact: true }))).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.evaluate(() => {
        (document.activeElement as HTMLElement | null)?.blur()
        for (const el of document.querySelectorAll('*')) if (el.scrollTop) el.scrollTop = 0
      })
      await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`${id}-${scheme}.png`) })
      await openView(page, 'Settings')
      await expect(page.getByRole('group', { name: 'Color theme', exact: true }).getByRole('button', { name: new RegExp(`^${name} `) })).toHaveAttribute('aria-pressed', 'true')
      await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`${id}-${scheme}-settings.png`) })
      await openView(page, 'Today')
    }
    if (id !== 'system1') {
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme })
        for (const view of ['Lists', 'Notes']) {
          await openView(page, view)
          await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`${id}-${scheme}-${view.toLowerCase()}.png`) })
        }
        await openView(page, 'Today')
        await page.keyboard.press('Alt+/')
        const shortcuts = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
        await expect(shortcuts).toBeVisible()
        const caption = await shortcuts.locator('.overlay-header').boundingBox()
        const client = await shortcuts.locator('.overlay-body').boundingBox()
        expect(caption).not.toBeNull()
        expect(client).not.toBeNull()
        // Regression: headerless-frame spacing used to add an empty strip to normal dialogs.
        expect(Math.abs(client!.y - (caption!.y + caption!.height))).toBeLessThanOrEqual(2)
        const close = shortcuts.getByRole('button', { name: 'Close', exact: true })
        await page.mouse.move(0, 0)
        await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`${id}-${scheme}-dialog.png`) })
        await close.hover()
        await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`${id}-${scheme}-close-hover.png`) })
        await page.mouse.down()
        await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`${id}-${scheme}-close-pressed.png`) })
        await page.mouse.up()
        await expect(shortcuts).not.toBeVisible()
        await page.keyboard.press('Alt+c')
        const search = page.getByRole('dialog', { name: 'Search Balance' })
        await expect(search).toBeVisible()
        await search.getByRole('searchbox', { name: 'Search everything' }).fill('garden')
        await expect(search.locator('.search-result').first()).toBeVisible()
        await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`${id}-${scheme}-search.png`) })
        await search.getByRole('button', { name: 'Close', exact: true }).click()
        // Every rendered sidebar icon and every piece of Start menu and Control
        // Panel artwork the stylesheets reference must resolve to a decodable image.
        const iconURLs = await page.locator(`.sidebar .${id === 'windowsxp' ? 'xp' : 'vista'}-icon`).evaluateAll(nodes => nodes.map(n => n.getAttribute('href')!))
        const artURLs = await page.evaluate(() => [...document.styleSheets].flatMap(sheet => {
          try { return [...sheet.cssRules].map(rule => rule.cssText) } catch { return [] }
        }).flatMap(text => [...text.matchAll(/url\(['"]?(\/themes\/windows(?:xp|vista)\/[^'")]+)['"]?\)/g)].map(match => match[1])))
        expect(artURLs.length).toBeGreaterThan(40)
        for (const url of new Set([...iconURLs, ...artURLs])) {
          expect(await page.evaluate(async src => {
            const image = new Image(); image.src = src
            await image.decode(); return image.naturalWidth > 0
          }, url)).toBe(true)
        }
      }
    }
    if (id !== 'system1' && !isMobile) {
      // Settings is Control Panel: its task pane lists the sections and jumps to them, without animating.
      await openView(page, 'Settings')
      const tasks = page.getByRole('complementary', { name: 'Settings sections' })
      const jumped = await tasks.getByRole('button', { name: 'Export folder', exact: true }).evaluate(button => {
        (button as HTMLElement).click()
        return document.querySelector('.workspace')!.scrollTop
      })
      expect(jumped).toBeGreaterThan(0)
      await expect(page.locator('[data-cp="folder"] h3')).toBeInViewport()
      expect(await page.locator('.workspace').evaluate(workspace => workspace.scrollTop)).toBe(jumped)
      await openView(page, 'Today')
    }
    if (id === 'system1') {
      // Only Control Panel themes have the task pane.
      await openView(page, 'Settings')
      await expect(page.locator('.control-panel-tasks')).toHaveCount(0)
      if (!isMobile) {
        const caption = page.locator('.window-caption')
        await expect(caption.locator('.window-caption-title')).toHaveText('Balance')
        for (const button of ['Close', 'Full Screen']) await expect(caption.getByRole('button', { name: button, exact: true })).toBeDisabled()
      }
      await openView(page, 'Today')
    }
    const checkbox = page.locator('.plan-row .check:not(:checked)').first()
    const itemId = await checkbox.evaluate(el => el.closest('[data-plan-item-id]')?.getAttribute('data-plan-item-id'))
    expect(itemId).toBeTruthy()
    await checkbox.check()
    await expect(page.locator(`[data-plan-item-id="${itemId}"] .check`)).toBeChecked()

  })
}

test('Mac System 1 typography and selection readability across the app', async ({ page, isMobile, browserName }, testInfo) => {
  test.skip(isMobile || browserName !== 'chromium', 'Desktop typography and screenshot audit')
  test.setTimeout(120_000)
  await page.clock.install({ time: new Date('2026-10-14T14:20:00') })
  await page.goto('/')
  await page.evaluate(state => {
    localStorage.clear()
    localStorage.setItem('balance.appState.v1', JSON.stringify(state))
    localStorage.setItem('balance:deviceAppearance.v1', JSON.stringify({ version: 1, themeId: 'system1', colorScheme: 'system' }))
  }, createScreenshotState('2026-10-14'))
  await page.reload()
  await page.evaluate(() => document.fonts.ready)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('DOM.enable')
  await cdp.send('CSS.enable')
  const { root } = await cdp.send('DOM.getDocument')
  for (const selector of ['.sidebar-brand-heading h1', '.sidebar .nav-label']) {
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector })
    const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId })
    expect(fonts.some(font => font.isCustomFont && /ChiKareGo/i.test(font.familyName) && font.glyphCount > 0)).toBe(true)
  }
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    for (const view of ['Today', 'Next', 'Days', 'Lists', 'Notes', 'Quizzes', 'Goals', 'Projects', 'Ideas', 'Situate', 'Settings']) {
      await openView(page, view)
      await page.evaluate(() => {
        (document.activeElement as HTMLElement | null)?.blur()
        for (const el of document.querySelectorAll('*')) if (el.scrollTop) el.scrollTop = 0
      })
      // Relative contrast protects readable selected labels without fixing RGB values.
      const contrast = await page.locator('.rail-chip.active, .sidebar nav button.active, .goal-date-head.viewed').evaluateAll(elements => {
        const rgb = (color: string) => (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number)
        const lum = (color: number[]) => color.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0)
        return elements.filter(el => (el as HTMLElement).offsetWidth > 0).map(el => {
          const s = getComputedStyle(el)
          const [a, b] = [lum(rgb(s.color)), lum(rgb(s.backgroundColor))].sort((a, b) => b - a)
          return { label: el.textContent?.trim(), ratio: (a + .05) / (b + .05) }
        })
      })
      for (const entry of contrast) expect(entry.ratio, `${view}: ${entry.label}`).toBeGreaterThanOrEqual(4.5)
      await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`mac-system1-${scheme}-${view.toLowerCase()}.png`) })
    }
    await page.keyboard.press('Alt+/')
    const shortcuts = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
    await expect(shortcuts).toBeVisible()
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`mac-system1-${scheme}-shortcuts.png`) })
    await shortcuts.getByRole('button', { name: 'Close', exact: true }).click()
    await page.keyboard.press('Alt+c')
    const search = page.getByRole('dialog', { name: 'Search Balance' })
    await expect(search).toBeVisible()
    await search.getByRole('searchbox', { name: 'Search everything' }).fill('garden')
    await expect(search.locator('.search-result').first()).toBeVisible()
    await search.getByRole('searchbox', { name: 'Search everything' }).press('ArrowDown')
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`mac-system1-${scheme}-search.png`) })
    await search.getByRole('button', { name: 'Close', exact: true }).click()
    await openView(page, 'Today')
    await page.locator('.day-pane .page-header h2').click({ button: 'right' })
    const menu = page.getByRole('menu', { name: 'Links' })
    await expect(menu).toBeVisible()
    const menuItem = menu.getByRole('menuitem').first()
    await menuItem.hover()
    expect(await menuItem.evaluate(el => getComputedStyle(el).color === getComputedStyle(el).backgroundColor)).toBe(false)
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`mac-system1-${scheme}-menu.png`) })
    await page.keyboard.press('Escape')
  }
})

for (const themeId of ['system1', 'windowsxp', 'windowsvista']) {
  test(`${themeId} paints nothing for the IMAX click handoff`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'The click handoff is macOS desktop only')
    await page.addInitScript(() => Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' }))
    await page.goto('/')
    await page.evaluate(themeId => {
      localStorage.clear()
      localStorage.setItem('balance:deviceAppearance.v1', JSON.stringify({ version: 1, themeId, colorScheme: 'light' }))
    }, themeId)
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-theme', themeId)

    const button = await page.getByRole('region', { name: 'Daily plan' }).getByRole('button', { name: 'Enter IMAX mode' }).boundingBox()
    if (!button) throw new Error('IMAX button has no box')
    await page.mouse.click(button.x + button.width / 2, button.y + button.height / 2)

    const handoff = page.locator('.imax-click-handoff')
    await expect(handoff).toHaveCount(1)
    const box = await handoff.boundingBox()
    if (!box) throw new Error('Click handoff has no box')
    const clip = { x: box.x - 2, y: box.y - 2, width: box.width + 4, height: box.height + 4 }
    const shown = await page.screenshot({ animations: 'disabled', clip })
    await handoff.evaluate(element => { (element as HTMLElement).style.visibility = 'hidden' })
    expect(shown.equals(await page.screenshot({ animations: 'disabled', clip }))).toBe(true)
  })
}

for (const [themeId, name] of [['windowsxp', 'Windows XP'], ['windowsvista', 'Windows Vista']] as const) {
  test(`${name} window caption and IMAX share the window, and every theme bitmap loads`, async ({ page, isMobile }) => {
    test.skip(isMobile, 'The window caption is desktop only')
    test.setTimeout(90_000)
    await page.goto('/')
    await page.evaluate(([state, themeId]) => {
      localStorage.clear()
      localStorage.setItem('balance.appState.v1', JSON.stringify(state))
      localStorage.setItem('balance:deviceAppearance.v1', JSON.stringify({ version: 1, themeId, colorScheme: 'light' }))
    }, [createScreenshotState('2026-10-14'), themeId] as const)
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-theme', themeId)

    const caption = page.locator('.window-caption')
    await openView(page, 'Today')
    await expect(caption.locator('.window-caption-title')).toHaveText('Today')
    // The caption buttons act on the native window, which a browser doesn't have.
    for (const button of ['Minimize', 'Maximize', 'Close']) await expect(caption.getByRole('button', { name: button, exact: true })).toBeDisabled()
    // The window fills the viewport; no desktop shows around it.
    expect(await page.locator('.app-shell').evaluate(shell => {
      const box = shell.getBoundingClientRect()
      return box.left === 0 && box.top === 0 && box.width === innerWidth && box.height === innerHeight
    })).toBe(true)
    // The header's IMAX button fits its whole logo.
    const enterImax = page.getByRole('region', { name: 'Daily plan' }).getByRole('button', { name: 'Enter IMAX mode' })
    expect(await enterImax.evaluate(button => button.scrollWidth <= button.clientWidth)).toBe(true)
    await enterImax.click()
    await expect(page.locator('.app-shell')).toHaveClass(/page-maximized/)
    // IMAX keeps its own exit in view, clear of the caption.
    const exitImax = page.getByRole('button', { name: 'Exit IMAX mode' })
    await expect(exitImax).toBeVisible()
    const exitBox = await exitImax.boundingBox()
    const captionBox = await caption.boundingBox()
    if (!exitBox || !captionBox) throw new Error('IMAX exit or caption has no box')
    expect(exitBox.y).toBeGreaterThanOrEqual(captionBox.y + captionBox.height)
    await exitImax.click()
    await expect(page.locator('.app-shell')).not.toHaveClass(/page-maximized/)
    await openView(page, 'Settings')
    await expect(caption.locator('.window-caption-title')).toHaveText('Settings')

    // Every bitmap the theme stylesheet names must exist; a missing one only shows as a gap.
    const urls = await page.evaluate(() => {
      const found = new Set<string>()
      for (const sheet of Array.from(document.styleSheets)) {
        let rules: CSSRuleList
        try { rules = sheet.cssRules } catch { continue }
        const walk = (list: CSSRuleList) => {
          for (const rule of Array.from(list)) {
            if ('cssRules' in rule) walk((rule as CSSGroupingRule).cssRules)
            for (const match of rule.cssText.matchAll(/url\(["']?(\/themes\/windows(?:xp|vista)\/[^"')]+)["']?\)/g)) found.add(match[1])
          }
        }
        walk(rules)
      }
      return [...found]
    })
    expect(urls.length).toBeGreaterThan(100)
    // The dev server answers unknown paths with the app's HTML, so check the type too.
    // A few at a time: hundreds at once make the dev server reset connections.
    for (let start = 0; start < urls.length; start += 8) {
      const batch = urls.slice(start, start + 8)
      const responses = await Promise.all(batch.map(async url => ({ url, response: await page.request.get(url) })))
      for (const { url, response } of responses) {
        expect(response.status(), url).toBe(200)
        expect(response.headers()['content-type'], url).toMatch(/^image\//)
      }
    }
  })
}
