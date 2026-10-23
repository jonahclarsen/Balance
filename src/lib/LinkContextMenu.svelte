<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { invoke, isTauri } from '@tauri-apps/api/core'
  import { get } from 'svelte/store'
  import { CheckMenuItem, Menu } from '@tauri-apps/api/menu'
  import { linkAtElement, parseNavigationURL } from './navigationLinks'
  import { bucketsLinkFromURL } from './bucketLinks'
  import { plannerStore } from './store'

  // A copy entry carries its link; a toggle carries its state and action.
  type Option = { label: string; url?: string; checked?: boolean; toggle?: () => void }

  let nativeMenu: Menu | undefined
  let menu: HTMLDivElement
  let options: Option[] = []
  let x = 0
  let y = 0
  let status = ''
  let failedURL = ''
  let previousFocus: HTMLElement | null = null
  let statusTimer: ReturnType<typeof setTimeout>

  function close(restore = false) {
    options = []
    if (restore) previousFocus?.focus({ preventScroll: true })
  }
  function copyWithSelection(url: string): boolean {
    const selection = document.getSelection()
    const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : []
    const fallback = document.createElement('textarea')
    fallback.value = url
    fallback.readOnly = true
    fallback.style.cssText = 'position:fixed;opacity:0;pointer-events:none'
    document.body.append(fallback)
    try {
      fallback.select()
      return document.execCommand('copy')
    } finally {
      fallback.remove()
      previousFocus?.focus({ preventScroll: true })
      selection?.removeAllRanges()
      for (const range of ranges) selection?.addRange(range)
    }
  }

  async function copy(url: string) {
    close(true)
    let copied = false
    try {
      if (isTauri()) {
        await invoke('write_balance_clipboard', { plainText: url, structuredPayload: '' }).catch(() => navigator.clipboard.writeText(url))
      } else await navigator.clipboard.writeText(url)
      copied = true
    } catch {
      try { copied = copyWithSelection(url) } catch { /* Keep the URL available for manual copying. */ }
    }
    status = copied ? 'Link copied' : 'Copy this link'
    failedURL = copied ? '' : url
    clearTimeout(statusTimer)
    if (copied) statusTimer = setTimeout(() => status = '', 2200)
  }

  async function open(event: MouseEvent) {
    // Shift preserves the browser's menu, including its spelling tools.
    if (event.shiftKey || !(event.target instanceof Element)) return
    // A long press in a field keeps the platform's cut/copy/paste menu.
    const touch = (event as PointerEvent).pointerType === 'touch' || (event as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } }).sourceCapabilities?.firesTouchEvents
    if (touch && event.target.closest('input, textarea, [contenteditable="true"]')) return
    const url = linkAtElement(event.target)
    if (!url) return
    event.preventDefault()
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const entries: Option[] = [{ label: 'Copy link', url }]
    const target = parseNavigationURL(url)
    const templateItemId = target?.kind === 'day-template' && target.itemId && event.target.closest('[data-template-item-id]') ? target.itemId : ''
    const gated = Boolean(templateItemId && get(plannerStore).templateItemConditions.find(({ id }) => id === templateItemId)?.noActiveProject)
    const itemToggle: Option | null = templateItemId ? {
      label: 'Only when no active project',
      checked: gated,
      toggle: () => plannerStore.setTemplateItemNoActiveProject(templateItemId, !gated),
    } : null
    if (target?.kind === 'day-template' || target?.kind === 'list-template') {
      entries.push({ label: 'Copy review link', url: `balance://review/${target.kind === 'day-template' ? 'day' : 'list'}/${target.id}` })
    } else if (url === 'balance://page/buckets' || url === 'balance://buckets') {
      entries.push({ label: 'Copy review link', url: 'balance://buckets/review' })
    } else if (target?.kind === 'bucket') {
      const reviewURL = `balance://buckets/review/${target.id}`
      if (bucketsLinkFromURL(reviewURL)) entries.push({ label: 'Copy review link', url: reviewURL })
    }
    if (isTauri() && !/Android|iPhone|iPad/.test(navigator.userAgent)) {
      try {
        const editable = Boolean(event.target.closest('input, textarea, [contenteditable="true"]'))
        await nativeMenu?.close()
        nativeMenu = await Menu.new({ items: [
          ...entries.map(entry => ({ text: entry.label, action: () => { void copy(entry.url!) } })),
          ...(itemToggle ? [{ item: 'Separator' as const }, await CheckMenuItem.new({ text: itemToggle.label, checked: itemToggle.checked, action: itemToggle.toggle })] : []),
          ...(editable ? [{ item: 'Separator' as const }, { item: 'Cut' as const }, { item: 'Copy' as const }, { item: 'Paste' as const }, { item: 'SelectAll' as const }] : []),
        ] })
        await nativeMenu.popup()
        return
      } catch { /* Browser menu remains available if native menus are unavailable. */ }
    }
    options = itemToggle ? [...entries, itemToggle] : entries
    const rect = event.target.getBoundingClientRect()
    x = event.clientX || rect.left
    y = event.clientY || rect.bottom
    await tick()
    x = Math.max(8, Math.min(x, window.innerWidth - menu.offsetWidth - 8))
    y = Math.max(8, Math.min(y, window.innerHeight - menu.offsetHeight - 8))
    menu.querySelector('button')?.focus()
  }

  onMount(() => {
    const copyRequest = (event: Event) => {
      if (event instanceof CustomEvent && typeof event.detail === 'string' && parseNavigationURL(event.detail)) {
        previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
        void copy(event.detail)
      }
    }
    window.addEventListener('balance-copy-link', copyRequest)
    const context = (event: MouseEvent) => { void open(event) }
    const dismiss = (event: PointerEvent) => { if (options.length && !menu?.contains(event.target as Node)) close() }
    const scroll = () => close()
    const key = (event: KeyboardEvent) => {
      if (!options.length) return
      if (event.key === 'Escape' || event.key === 'Tab') {
        event.preventDefault()
        event.stopImmediatePropagation()
        close(true)
      } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault()
        event.stopImmediatePropagation()
        const buttons = Array.from(menu.querySelectorAll('button'))
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length
        buttons[next]?.focus()
      }
    }
    document.addEventListener('contextmenu', context)
    document.addEventListener('pointerdown', dismiss, true)
    window.addEventListener('keydown', key, true)
    window.addEventListener('resize', scroll)
    document.addEventListener('scroll', scroll, true)
    return () => {
      clearTimeout(statusTimer)
      void nativeMenu?.close()
      window.removeEventListener('balance-copy-link', copyRequest)
      document.removeEventListener('contextmenu', context)
      document.removeEventListener('pointerdown', dismiss, true)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('resize', scroll)
      document.removeEventListener('scroll', scroll, true)
    }
  })
</script>

{#if options.length}
  <div class="link-context-menu" role="menu" aria-label="Links" bind:this={menu} style:left={`${x}px`} style:top={`${y}px`}>
    {#each options as option}
      {#if option.toggle}
        <button class="menu-toggle" type="button" role="menuitemcheckbox" aria-checked={option.checked} on:click={() => { option.toggle?.(); close(true) }}><span class="menu-check" aria-hidden="true">{option.checked ? '✓' : ''}</span>{option.label}</button>
      {:else}
        <button type="button" role="menuitem" on:click={() => copy(option.url!)}>{option.label}</button>
      {/if}
    {/each}
  </div>
{/if}
{#if status}
  <div class="link-copy-status" role="status">
    {status}
    {#if failedURL}<input aria-label="Link to copy" readonly value={failedURL} on:focus={(event) => event.currentTarget.select()} /><button type="button" on:click={() => { status = ''; failedURL = '' }}>Done</button>{/if}
  </div>
{/if}

<style>
  .link-context-menu { position: fixed; z-index: 10000; min-width: 160px; padding: 4px; border: 1px solid var(--line); border-radius: 8px; background: var(--paper); box-shadow: 0 8px 24px #0003; }
  .link-context-menu button { display: block; width: 100%; text-align: left; border: 0; background: transparent; padding: 9px 12px; }
  .link-context-menu .menu-toggle { display: flex; gap: 6px; border-top: 1px solid var(--line); border-radius: 0; }
  .menu-check { flex: 0 0 1em; }
  .link-context-menu button:hover, .link-context-menu button:focus-visible { background: var(--line); }
  .link-copy-status { position: fixed; z-index: 10001; bottom: 20px; left: 50%; transform: translateX(-50%); max-width: calc(100vw - 32px); padding: 10px 16px; border: 1px solid var(--line); border-radius: 8px; background: var(--paper); color: var(--ink); }
  .link-copy-status input { display: block; width: min(480px, 75vw); margin-block: 8px; }
</style>
