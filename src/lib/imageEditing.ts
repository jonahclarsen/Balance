import { plannerStore } from './store'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { get } from 'svelte/store'
import { clipboardHasDirectImage, IMAGE_CLIPBOARD_TYPE, IMAGE_SELECTOR, imageHTML, sanitizeImage } from './imageMarkup'
import { imageSources, imageViewer, imageClipboardHTML, stageClipboardImages, importImage, reportImageError, selectedImage } from './imageService'

type ImageDrag = { image: HTMLImageElement; commit: () => void }
let dragged: ImageDrag | null = null
const dropTargets = new WeakMap<HTMLElement, (x: number, y: number, source: ImageDrag, copy: boolean) => void>()

export function hydrateImages(root: ParentNode) {
  for (const image of root.querySelectorAll<HTMLImageElement>(IMAGE_SELECTOR)) {
    const src = imageSources.get(image.dataset.balanceImage ?? '')
    if (src && image.getAttribute('src') !== src) image.src = src
  }
}

export function imageEditing(editor: HTMLElement, commit: () => void) {
  function select(image: HTMLImageElement) {
    get(selectedImage)?.image.removeAttribute('data-image-selected')
    image.dataset.imageSelected = ''
    editor.focus()
    const range = document.createRange()
    range.selectNode(image)
    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    selectedImage.set({ image, editor, commit })
  }
  function clicked(event: MouseEvent) {
    if (event.target instanceof HTMLImageElement && event.target.matches(IMAGE_SELECTOR)) {
      event.preventDefault()
      event.stopPropagation()
      select(event.target)
    } else {
      get(selectedImage)?.image.removeAttribute('data-image-selected')
      selectedImage.set(null)
    }
  }
  function doubleClicked(event: MouseEvent) {
    if (!(event.target instanceof HTMLImageElement) || !event.target.matches(IMAGE_SELECTOR)) return
    event.preventDefault()
    event.stopPropagation()
    imageViewer.set(event.target.dataset.balanceImage!)
  }
  function insert(html: string, range: Range) {
    if (!editor.isConnected) return
    editor.focus()
    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    range.deleteContents()
    const template = document.createElement('template')
    template.innerHTML = html
    const last = template.content.lastChild
    range.insertNode(template.content)
    if (last) { range.setStartAfter(last); range.collapse(true) }
    selection?.removeAllRanges()
    selection?.addRange(range)
    commit()
    hydrateImages(editor)
  }
  function currentRange(): Range {
    const selection = document.getSelection()
    if (selection?.rangeCount && editor.contains(selection.getRangeAt(0).commonAncestorContainer)) return selection.getRangeAt(0).cloneRange()
    const range = document.createRange()
    range.selectNodeContents(editor)
    range.collapse(false)
    return range
  }
  async function insertFiles(files: Blob[], range = currentRange()) {
    try {
      for (const file of files) {
        const asset = await importImage(file)
        if (!asset) continue
        const width = Math.min(asset.width, 480, editor.clientWidth || 480)
        insert(imageHTML(asset.id, width, width * asset.height / asset.width), range)
      }
    } catch (error) { reportImageError(error) }
  }
  function paste(event: ClipboardEvent) {
    const data = event.clipboardData
    if (!data) return
    const internal = data.getData(IMAGE_CLIPBOARD_TYPE)
    stageClipboardImages(internal || data.getData('text/html'))
    if (internal) {
      event.preventDefault(); event.stopImmediatePropagation()
      editor.dispatchEvent(new CustomEvent('balancepaste', { detail: { plainText: '', html: internal } }))
    } else if (clipboardHasDirectImage(data)) {
      event.preventDefault(); event.stopImmediatePropagation()
      void insertFiles(Array.from(data.files).filter((file) => file.type.startsWith('image/')))
    } else if (isTauri() && !data.getData('text/html') && (!data.getData('text/plain') || data.getData('text/plain').startsWith('content://'))) {
      event.preventDefault(); event.stopImmediatePropagation()
      const range = currentRange()
      void invoke<{ imageDataURL?: string }>('read_balance_clipboard').then(async (clipboard) => {
        if (clipboard.imageDataURL) await insertFiles([await (await fetch(clipboard.imageDataURL)).blob()], range)
      }).catch(reportImageError)
    }
  }
  function programmatic(event: Event) {
    const detail = (event as CustomEvent<{ imageDataURL?: string; html?: string }>).detail
    if (detail?.html) stageClipboardImages(detail.html)
    if (!detail?.imageDataURL) return
    event.stopImmediatePropagation()
    const range = currentRange()
    void fetch(detail.imageDataURL).then((response) => response.blob()).then((blob) => insertFiles([blob], range)).catch(reportImageError)
  }
  function copy(event: ClipboardEvent) {
    const selection = document.getSelection()
    if (!selection?.rangeCount || selection.isCollapsed || !event.clipboardData) return
    const contents = selection.getRangeAt(0).cloneContents()
    if (!contents.querySelector(IMAGE_SELECTOR)) return
    const container = document.createElement('div')
    container.append(contents)
    container.querySelectorAll<HTMLImageElement>(IMAGE_SELECTOR).forEach((image) => { image.outerHTML = sanitizeImage(image) })
    const html = imageClipboardHTML(container.innerHTML)
    event.clipboardData.setData(IMAGE_CLIPBOARD_TYPE, html)
    event.clipboardData.setData('text/html', html)
    event.clipboardData.setData('text/plain', container.textContent || '\uFFFC')
    event.preventDefault(); event.stopPropagation()
    if (event.type === 'cut') { selection.deleteFromDocument(); commit(); selectedImage.set(null) }
  }
  function keydown(event: KeyboardEvent) {
    const selected = get(selectedImage)
    if (selected?.editor !== editor || !selected.image.isConnected) return
    if (event.key === 'Backspace' || event.key === 'Delete') {
      event.preventDefault(); event.stopImmediatePropagation()
      const range = document.createRange()
      range.setStartBefore(selected.image); range.collapse(true)
      selected.image.remove()
      selectedImage.set(null)
      const selection = document.getSelection()
      selection?.removeAllRanges(); selection?.addRange(range)
      commit()
    } else if (event.key === 'Escape' || event.key.startsWith('Arrow')) {
      selected.image.removeAttribute('data-image-selected'); selectedImage.set(null)
    }
  }
  function dragstart(event: DragEvent) {
    if (cancelPointerDrag) { event.preventDefault(); event.stopPropagation(); return }
    if (!(event.target instanceof HTMLImageElement) || !event.target.matches(IMAGE_SELECTOR) || !event.dataTransfer) return
    dragged = { image: event.target, commit }
    event.dataTransfer.setData(IMAGE_CLIPBOARD_TYPE, sanitizeImage(event.target))
    event.dataTransfer.setData('text/html', sanitizeImage(event.target))
    event.dataTransfer.setData('text/plain', '\uFFFC')
    event.dataTransfer.effectAllowed = 'copyMove'
    event.stopPropagation()
  }
  function dragover(event: DragEvent) {
    if (event.dataTransfer && (dragged || Array.from(event.dataTransfer.types).includes('Files'))) {
      event.preventDefault(); event.stopPropagation()
      event.dataTransfer.dropEffect = dragged && !event.altKey ? 'move' : 'copy'
    }
  }
  function drop(event: DragEvent) {
    const data = event.dataTransfer
    if (!data || (!dragged && !Array.from(data.files).some((file) => file.type.startsWith('image/')))) return
    event.preventDefault(); event.stopPropagation()
    const doc = document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }
    const point = doc.caretRangeFromPoint?.(event.clientX, event.clientY)
    const range = point && editor.contains(point.startContainer) ? point : currentRange()
    if (dragged) {
      const source = dragged
      dragged = null
      const html = sanitizeImage(source.image)
      plannerStore.moveImage(() => {
        const sourceEditor = source.image.closest('[data-rich-text-input]')
        if (!event.altKey) source.image.remove()
        if (!event.altKey && sourceEditor !== editor) source.commit()
        insert(html, range)
      })
      selectedImage.set(null)
    } else void insertFiles(Array.from(data.files).filter((file) => file.type.startsWith('image/')), range)
  }
  function moveAt(x: number, y: number, source: ImageDrag, copy: boolean) {
    if (!source.image.isConnected) return
    const doc = document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }
    const point = doc.caretRangeFromPoint?.(x, y)
    const range = point && editor.contains(point.startContainer) ? point : currentRange()
    const html = sanitizeImage(source.image)
    plannerStore.moveImage(() => {
      const sourceEditor = source.image.closest('[data-rich-text-input]')
      if (!copy) source.image.remove()
      if (!copy && sourceEditor !== editor) source.commit()
      insert(html, range)
    })
    selectedImage.set(null)
  }
  dropTargets.set(editor, moveAt)
  let cancelPointerDrag: (() => void) | null = null
  function pointerdown(event: PointerEvent) {
    if (!(event.target instanceof HTMLImageElement) || !event.target.matches(IMAGE_SELECTOR)) return
    event.stopPropagation()
    if (event.pointerType !== 'mouse' || event.button !== 0) return
    event.preventDefault()
    const source = { image: event.target, commit }
    select(source.image)
    const initialX = event.clientX, initialY = event.clientY
    let ghost: HTMLImageElement | null = null
    let caret: HTMLDivElement | null = null
    const cleanup = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('blur', cleanup)
      ghost?.remove(); caret?.remove()
      cancelPointerDrag = null
    }
    const move = (next: PointerEvent) => {
      if (!ghost && Math.hypot(next.clientX - initialX, next.clientY - initialY) < 5) return
      if (!ghost) {
        ghost = source.image.cloneNode() as HTMLImageElement
        ghost.removeAttribute('data-balance-image')
        ghost.style.cssText = `position:fixed;pointer-events:none;z-index:10000;opacity:.55;margin:0;float:none;width:${Math.min(160, source.image.width)}px;height:auto`
        document.body.append(ghost)
        caret = document.createElement('div')
        caret.style.cssText = 'position:fixed;pointer-events:none;z-index:10001;width:2px;background:var(--accent);height:22px'
        document.body.append(caret)
      }
      ghost.style.left = `${next.clientX + 12}px`; ghost.style.top = `${next.clientY + 12}px`
      const target = document.elementFromPoint(next.clientX, next.clientY)?.closest<HTMLElement>('[data-rich-text-input]')
      const doc = document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }
      const rect = doc.caretRangeFromPoint?.(next.clientX, next.clientY)?.getBoundingClientRect()
      if (caret) {
        caret.style.display = target ? 'block' : 'none'
        caret.style.left = `${rect?.x || next.clientX}px`; caret.style.top = `${rect?.y || next.clientY}px`
      }
    }
    const finish = (next: PointerEvent) => {
      const moved = !!ghost
      cleanup()
      if (!moved) return
      const target = document.elementFromPoint(next.clientX, next.clientY)?.closest<HTMLElement>('[data-rich-text-input]')
      if (target) dropTargets.get(target)?.(next.clientX, next.clientY, source, next.altKey)
    }
    cancelPointerDrag = cleanup
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish, { once: true })
    window.addEventListener('blur', cleanup, { once: true })
  }
  function dragend() { dragged = null }
  const handlers = { pointerdown, dragend, click: clicked, dblclick: doubleClicked, paste, copy, cut: copy, keydown, dragstart, dragover, drop, balancepaste: programmatic }
  for (const [type, listener] of Object.entries(handlers)) editor.addEventListener(type, listener as EventListener, true)
  return {
    update(next: () => void) { commit = next },
    destroy() {
      cancelPointerDrag?.()
      dropTargets.delete(editor)
      for (const [type, listener] of Object.entries(handlers)) editor.removeEventListener(type, listener as EventListener, true)
      if (get(selectedImage)?.editor === editor) selectedImage.set(null)
    },
  }
}
