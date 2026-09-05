<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { plannerStore } from './store'
  import { encodeWebP } from './imageCompression'
  import { hydrateImages } from './imageEditing'
  import { IMAGE_SELECTOR, initialImageScale, type ImageLayout } from './imageMarkup'
  import { decodeImage, imageAssets, imageError, imageImport, imageSources, imageViewer, selectedImage, setImageSaver, MAX_IMAGE_BYTES, IMAGE_SIZE_LIMIT_MESSAGE, type ImageImport } from './imageService'

  let dialog: HTMLDialogElement
  let active: ImageImport | null = null
  let original: HTMLImageElement | null = null
  let originalURL = ''
  let resultURL = ''
  let result: Blob | null = null
  let scale = 100
  let quality = 80
  let processing = false
  let generation = 0
  let cropX = .5
  let cropY = .5
  let showOriginal = false
  let modalError = ''
  let previousFocus: HTMLElement | null = null
  let selectionRect: DOMRect | null = null
  let cropCanvas: HTMLCanvasElement
  let outputWidth = 0
  let outputHeight = 0
  let encoderAbort: AbortController | null = null
  let encodeTimer: ReturnType<typeof setTimeout>
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+'

  onMount(() => {
    setImageSaver((asset) => plannerStore.stageImage(asset))
    let previousImages: unknown = null
    const unsubscribe = plannerStore.subscribe((state) => {
      if (state.images === previousImages) return
      previousImages = state.images
      imageAssets.clear()
      for (const asset of state.images) imageAssets.set(asset.id, asset)
      const keep = new Set(state.images.map((asset) => asset.id))
      for (const [id, url] of imageSources) if (!keep.has(id)) { URL.revokeObjectURL(url); imageSources.delete(id) }
      for (const asset of state.images) {
        if (imageSources.has(asset.id)) continue
        const match = /^data:(image\/(?:png|jpeg|webp|gif|avif|bmp));base64,([A-Za-z0-9+/=]+)$/.exec(asset.dataURL)
        if (!match) continue
        try {
          const bytes = Uint8Array.from(atob(match[2]), (character) => character.charCodeAt(0))
          imageSources.set(asset.id, URL.createObjectURL(new Blob([bytes], { type: match[1] })))
        } catch { /* A malformed remote asset must not prevent the rest from loading. */ }
      }
      hydrateImages(document)
    })
    const observer = new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) {
        if (node instanceof Element) hydrateImages(node.parentElement ?? node)
      }
      if ($selectedImage && !$selectedImage.image.isConnected) selectedImage.set(null)
    })
    observer.observe(document.body, { subtree: true, childList: true })
    const updateRect = () => { selectionRect = $selectedImage?.image.getBoundingClientRect() ?? null }
    const unselect = selectedImage.subscribe(updateRect)
    document.addEventListener('scroll', updateRect, true)
    window.addEventListener('resize', updateRect)
    const show = (event: MouseEvent) => {
      if (event.target instanceof HTMLImageElement && event.target.matches(IMAGE_SELECTOR)) imageViewer.set(event.target.dataset.balanceImage!)
    }
    document.addEventListener('dblclick', show)
    return () => {
      observer.disconnect(); unsubscribe(); unselect()
      document.removeEventListener('scroll', updateRect, true)
      window.removeEventListener('resize', updateRect)
      document.removeEventListener('dblclick', show)
      for (const url of imageSources.values()) URL.revokeObjectURL(url)
      imageSources.clear(); imageAssets.clear()
      clearTimeout(encodeTimer)
      releasePreview()
    }
  })

  $: if ($imageImport && $imageImport !== active) void beginImport($imageImport)
  $: viewedAsset = $plannerStore.images.find((asset) => asset.id === $imageViewer)
  $: if ($imageViewer || $imageImport || $imageError) void openDialog()
  $: if (!$imageViewer && !$imageImport && !$imageError && dialog?.open) {
    dialog.close()
    previousFocus?.focus({ preventScroll: true })
  }
  $: if (original && active) scheduleEncode(scale, quality)
  $: if (cropCanvas && original && (resultURL || showOriginal)) void drawCrop(resultURL, showOriginal, cropX, cropY)

  async function openDialog() {
    await tick()
    if (!dialog.open) {
      previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
      dialog.showModal()
    }
  }
  function releasePreview() {
    encoderAbort?.abort()
    if (originalURL) URL.revokeObjectURL(originalURL)
    if (resultURL) URL.revokeObjectURL(resultURL)
    originalURL = ''; resultURL = ''; result = null
  }
  async function beginImport(request: ImageImport) {
    active = request
    original = null
    releasePreview()
    modalError = ''; processing = true; quality = 80; cropX = .5; cropY = .5; showOriginal = false
    try {
      const decoded = await decodeImage(request.blob)
      if (active !== request) return
      originalURL = URL.createObjectURL(request.blob)
      scale = initialImageScale(decoded.naturalWidth, decoded.naturalHeight)
      original = decoded
    } catch (error) { processing = false; modalError = String(error) }
  }
  function scheduleEncode(nextScale: number, nextQuality: number) {
    const token = ++generation
    encoderAbort?.abort()
    processing = true
    clearTimeout(encodeTimer)
    encodeTimer = setTimeout(() => void encode(token, nextScale, nextQuality), 80)
  }
  async function encode(token: number, nextScale: number, nextQuality: number) {
    if (!original) return
    try {
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(original.naturalWidth * nextScale / 100))
      canvas.height = Math.max(1, Math.round(original.naturalHeight * nextScale / 100))
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Image preview is unavailable.')
      context.drawImage(original, 0, 0, canvas.width, canvas.height)
      encoderAbort = new AbortController()
      const blob = await encodeWebP(context.getImageData(0, 0, canvas.width, canvas.height), nextQuality, encoderAbort.signal)
      if (token !== generation) return
      if (resultURL) URL.revokeObjectURL(resultURL)
      result = blob; resultURL = URL.createObjectURL(blob)
      outputWidth = canvas.width; outputHeight = canvas.height
      modalError = ''
    } catch (error) { if (token === generation) { result = null; modalError = String(error) } }
    finally { if (token === generation) processing = false }
  }
  let cropGeneration = 0
  async function drawCrop(url: string, useOriginal: boolean, x: number, y: number) {
    const token = ++cropGeneration
    const source = new Image()
    source.src = useOriginal ? originalURL : url
    if (!source.src) return
    try { await source.decode() } catch { return }
    if (token !== cropGeneration || !cropCanvas || !original) return
    const context = cropCanvas.getContext('2d')
    if (!context) return
    const factor = source.naturalWidth / original.naturalWidth
    const cropWidth = Math.min(original.naturalWidth, 180)
    const cropHeight = Math.min(original.naturalHeight, 180)
    const left = Math.max(0, Math.min(original.naturalWidth - cropWidth, x * original.naturalWidth - cropWidth / 2))
    const top = Math.max(0, Math.min(original.naturalHeight - cropHeight, y * original.naturalHeight - cropHeight / 2))
    context.clearRect(0, 0, 360, 360)
    context.drawImage(source, left * factor, top * factor, cropWidth * factor, cropHeight * factor, 0, 0, 360, 360)
  }
  function finish(blob: Blob | null) {
    if (blob && blob.size >= MAX_IMAGE_BYTES) return
    const request = active
    ++generation; ++cropGeneration; clearTimeout(encodeTimer)
    active = null; original = null
    imageImport.set(null)
    releasePreview()
    request?.resolve(blob)
  }
  function close() {
    if (active) finish(null)
    imageViewer.set(null); imageError.set('')
  }
  function keydown(event: KeyboardEvent) {
    event.stopPropagation()
    if (event.key === 'Escape') { event.preventDefault(); close() }
    else if (event.key === 'Enter' && active && !event.isComposing) {
      event.preventDefault()
      if (event.metaKey || event.ctrlKey) finish(active.blob)
      else if (result && !processing) finish(result)
    }
  }
  function pickCrop(event: MouseEvent) {
    const rect = (event.currentTarget as HTMLImageElement).getBoundingClientRect()
    cropX = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
    cropY = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))
  }
  function bytes(value: number) { return value < 1_000_000 ? `${(value / 1000).toFixed(1)} KB` : `${(value / 1_000_000).toFixed(2)} MB` }
  function layout(value: ImageLayout) {
    if (!$selectedImage) return
    const { image, commit } = $selectedImage
    image.dataset.imageLayout = value
    selectedImage.set(null)
    commit()
  }
  function resize(event: PointerEvent, corner: string) {
    if (!$selectedImage) return
    event.preventDefault(); event.stopPropagation()
    const selection = $selectedImage
    const { image } = selection
    const start = image.getBoundingClientRect()
    const ratio = Number(image.getAttribute('height')) / Number(image.getAttribute('width'))
    const initialWidth = image.width
    const initialHeight = image.height
    const x = event.clientX
    const target = event.currentTarget as HTMLElement
    target.setPointerCapture(event.pointerId)
    const move = (next: PointerEvent) => {
      const width = Math.round(Math.max(24, Math.min(selection.editor.clientWidth, start.width + (next.clientX - x) * (corner.endsWith('left') ? -1 : 1))))
      image.width = width; image.height = Math.round(width * ratio)
      selectionRect = image.getBoundingClientRect()
    }
    const done = (next: PointerEvent) => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', done)
      target.removeEventListener('pointercancel', done)
      if (next.type === 'pointercancel') { image.width = initialWidth; image.height = initialHeight }
      selectedImage.set(null)
      if (next.type !== 'pointercancel') selection.commit()
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', done)
    target.addEventListener('pointercancel', done)
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<dialog bind:this={dialog} data-image-dialog class:viewer={!!$imageViewer} on:keydown={keydown} on:cancel|preventDefault={close} on:click={(event) => { if (event.target === dialog) close() }} aria-label={$imageViewer ? 'Image viewer' : 'Paste image'}>
  {#if $imageViewer}
    <img class="full-image" style:width={viewedAsset ? `min(calc(100vw - 32px), calc((100dvh - 32px) * ${viewedAsset.width / viewedAsset.height}))` : undefined} src={imageSources.get($imageViewer)} alt="Enlarged view" />
    <button class="viewer-close" aria-label="Close image" on:click={close}>×</button>
  {:else if $imageError}
    <div class="image-error"><p>{$imageError}</p><button on:click={close}>Close</button></div>
  {:else if active}
    <div class="compression">
      <header><h2>Paste image</h2><button aria-label="Cancel image paste" on:click={close}>×</button></header>
      <div class="previews">
        <div class="main-preview">
          {#if originalURL}
            <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
            <img src={showOriginal || !resultURL ? originalURL : resultURL} alt="Compression preview; click to inspect a detail" on:click={pickCrop} />
          {/if}
        </div>
        <div class="detail-preview"><canvas bind:this={cropCanvas} width="360" height="360" aria-label="Magnified image detail"></canvas><span>Detail · click the image to inspect</span><button on:pointerdown={() => showOriginal = true} on:pointerup={() => showOriginal = false} on:pointerleave={() => showOriginal = false} on:keydown={(e) => { if (e.key === ' ') { e.preventDefault(); showOriginal = true } }} on:keyup={() => showOriginal = false} on:blur={() => showOriginal = false}>Hold to show original</button></div>
      </div>
      <div class="sliders">
        <label>Scale <output>{scale}%</output><input aria-label="Image scale" type="range" min="1" max="100" step="1" bind:value={scale} /></label>
        <label>WebP quality <output>{quality}</output><input aria-label="WebP quality" type="range" min="1" max="100" step="1" bind:value={quality} /></label>
      </div>
      <div class="image-size" aria-live="polite">{bytes(active.blob.size)} → {processing ? 'Updating…' : result ? bytes(result.size) : '—'}{#if result && !processing} · {outputWidth} × {outputHeight} · {Math.round((1 - result.size / active.blob.size) * 100)}% smaller{/if}</div>
      {#if original}<div class="original-dimensions">Original: {original.naturalWidth} × {original.naturalHeight}</div>{/if}
      {#if active.blob.size >= MAX_IMAGE_BYTES || (result && !processing && result.size >= MAX_IMAGE_BYTES)}<p role="status">{IMAGE_SIZE_LIMIT_MESSAGE}</p>{/if}
      {#if modalError}<p role="alert">{modalError}</p>{/if}
      <footer><button on:click={() => finish(null)}>Cancel <kbd>Esc</kbd></button><div><button disabled={active.blob.size >= MAX_IMAGE_BYTES} on:click={() => active && finish(active.blob)}>Paste original <kbd>{mod}Enter</kbd></button><button class="primary" disabled={processing || !result || result.size >= MAX_IMAGE_BYTES} on:click={() => result && finish(result)}>Paste image <kbd>Enter</kbd></button></div></footer>
    </div>
  {/if}
</dialog>

{#if $selectedImage && selectionRect && !dialog?.open}
  <div class="image-selection" style:left={`${selectionRect.left}px`} style:top={`${selectionRect.top}px`} style:width={`${selectionRect.width}px`} style:height={`${selectionRect.height}px`}>
    {#each ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as corner}<button class={`resize-handle ${corner}`} aria-label={`Resize image ${corner}`} on:pointerdown={(event) => resize(event, corner)}></button>{/each}
    <div tabindex="-1" role="toolbar" aria-label="Image layout" class="image-tools" style:top={selectionRect.top < 48 ? '100%' : '-42px'} on:mousedown|preventDefault>
      <button class:active={$selectedImage.image.dataset.imageLayout === 'inline'} on:click={() => layout('inline')}>Inline</button><button class:active={$selectedImage.image.dataset.imageLayout === 'left'} on:click={() => layout('left')}>Wrap left</button><button class:active={$selectedImage.image.dataset.imageLayout === 'right'} on:click={() => layout('right')}>Wrap right</button>
    </div>
  </div>
{/if}

<style>
  dialog { padding: 0; border: 1px solid var(--line); border-radius: 14px; background: var(--paper); color: var(--ink); width: min(1120px, calc(100vw - 40px)); max-width: none; max-height: calc(100dvh - 40px); overflow: auto; box-shadow: 0 18px 80px #0006; }
  dialog::backdrop { background: #000a; }
  dialog.viewer { width: calc(100vw - 32px); height: calc(100dvh - 32px); max-height: none; border: 0; background: transparent; box-shadow: none; overflow: hidden; }
  .full-image { display: block; max-width: 100%; max-height: 100%; width: auto; height: auto; margin: auto; position: absolute; inset: 0; object-fit: contain; }
  .viewer-close { position: fixed; right: 20px; top: 20px; border-radius: 50%; background: #222b; color: white; font-size: 24px; }
  .compression { padding: 24px; }
  header, footer, footer > div { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  h2 { margin: 0; font-size: 20px; }
  header { margin-bottom: 18px; }
  button { cursor: pointer; padding: 8px 12px; border: 1px solid var(--line); border-radius: 7px; color: inherit; background: var(--paper-strong); font: inherit; }
  button:disabled { opacity: .45; cursor: default; }
  button.primary, button.active { background: var(--accent); color: white; }
  .previews { display: grid; grid-template-columns: minmax(0, 1fr) minmax(180px, 28%); gap: 18px; align-items: center; }
  .main-preview { display: flex; justify-content: center; align-items: center; height: clamp(160px, 45dvh, 520px); background: #8881; border-radius: 8px; overflow: hidden; }
  .main-preview img { max-width: 100%; max-height: 100%; object-fit: contain; cursor: crosshair; }
  .detail-preview { display: flex; flex-direction: column; gap: 10px; font-size: 12px; }
  canvas { width: 100%; height: auto; background: #8882; border-radius: 8px; }
  .sliders { display: grid; gap: 12px; margin: 20px 0 14px; }
  label { display: grid; grid-template-columns: 1fr auto; gap: 6px; }
  input { accent-color: var(--accent); grid-column: 1 / -1; width: 100%; }
  .image-size { font-variant-numeric: tabular-nums; }
  .original-dimensions { font-size: 12px; opacity: .7; margin-top: 5px; }
  footer { margin-top: 22px; }
  kbd { margin-left: 7px; opacity: .65; font-size: 11px; }
  .image-error { padding: 24px; }
  .image-selection { position: fixed; z-index: 9000; pointer-events: none; outline: 2px solid var(--accent); }
  .resize-handle { position: absolute; pointer-events: auto; touch-action: none; padding: 0; width: 12px; height: 12px; border: 2px solid white; border-radius: 2px; background: #7095dd; }
  .top-left { left: -6px; top: -6px; cursor: nwse-resize; } .top-right { right: -6px; top: -6px; cursor: nesw-resize; }
  .bottom-left { left: -6px; bottom: -6px; cursor: nesw-resize; } .bottom-right { right: -6px; bottom: -6px; cursor: nwse-resize; }
  .image-tools { position: absolute; left: 0; display: flex; white-space: nowrap; pointer-events: auto; background: var(--paper); border-radius: 7px; box-shadow: 0 3px 12px #0005; }
  .image-tools button { padding: 6px 9px; font-size: 12px; }
  :global(img[data-balance-image]) { display: inline-block; max-width: 100%; height: auto; vertical-align: middle; object-fit: contain; cursor: grab; border-radius: 3px; }
  :global(img[data-image-layout='left']) { float: left; margin: .25em 1em .5em 0; }
  :global(img[data-image-layout='right']) { float: right; margin: .25em 0 .5em 1em; }
  :global([data-rich-text-input]:has(img[data-balance-image])) { display: flow-root; white-space: pre-wrap; }
  @media (max-width: 600px) { .compression { padding: 16px; } .previews { grid-template-columns: minmax(0, 1fr) 100px; gap: 10px; } .detail-preview { font-size: 10px; } footer { align-items: stretch; flex-direction: column; } footer > div { flex-wrap: wrap; } kbd { display: none; } }
</style>
