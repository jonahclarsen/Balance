<script lang="ts">
  import OverlayModal from './OverlayModal.svelte'
  import { extensionStatus, extensionSetupOpen, checkExtension } from './situate/extension'
  let copied = ''
  $: browsers = $extensionStatus?.browsers ?? []
  $: folder = $extensionStatus?.folder ?? ''
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); copied = text; setTimeout(() => { if (copied === text) copied = '' }, 1500) } catch { /* Clipboard unavailable. */ }
  }
</script>
{#if $extensionSetupOpen}
  <OverlayModal title="Install the Situate extension" onClose={() => extensionSetupOpen.set(false)} maxWidth={560} z={70}>
    <div class="setup">
      <ul class="browsers">
        {#each browsers as browser}
          {@const done = browser.extension && browser.host}
          <li class:done><span class="mark" aria-hidden="true">{done ? '✓' : '!'}</span>{browser.name}<span class="state">{done ? 'Connected' : 'Not installed'}</span></li>
        {:else}<li>No Chrome or Brave found</li>{/each}
      </ul>
      {#each browsers.filter(b => !b.extension || !b.host) as browser}
        <section>
          <h3>{browser.name}</h3>
          <ol>
            <li><span>Open extensions</span><button type="button" on:click={() => checkExtension(`open-${browser.id}`)}>Open</button></li>
            <li><span>Turn on <b>Developer mode</b> (top right)</span></li>
            <li><span>Click <b>Load unpacked</b>, press <kbd>⌘⇧G</kbd>, paste the folder, then <b>Open</b></span><button type="button" on:click={() => copy(folder)}>{copied === folder ? 'Copied' : 'Copy folder'}</button></li>
          </ol>
        </section>
      {/each}
      {#if browsers.length && browsers.every(b => b.extension && b.host)}<p class="all-done">All set.</p>{/if}
    </div>
  </OverlayModal>
{/if}
<style>
  .setup { display:grid; gap:16px; }
  .browsers { list-style:none; margin:0; padding:0; display:grid; gap:6px; }
  .browsers li { display:flex; align-items:center; gap:10px; padding:10px 12px; border:1px solid color-mix(in srgb, var(--danger) 45%, var(--line)); border-radius:10px; background:color-mix(in srgb, var(--danger) 7%, transparent); font-weight:600; }
  .browsers li.done { border-color:color-mix(in srgb, var(--theme-done) 45%, var(--line)); background:color-mix(in srgb, var(--theme-done) 8%, transparent); }
  .mark { display:grid; place-items:center; width:22px; height:22px; border-radius:50%; color:white; background:var(--danger); font-size:13px; }
  .done .mark { background:var(--theme-done); }
  .state { margin-left:auto; font-weight:500; font-size:13px; color:var(--muted); }
  section { border-top:1px solid var(--line); padding-top:14px; }
  h3 { margin:0 0 10px; font-size:15px; }
  ol { margin:0; padding:0; list-style:none; counter-reset:step; display:grid; gap:8px; }
  ol li { counter-increment:step; display:flex; align-items:center; gap:10px; min-height:34px; }
  ol li::before { content:counter(step); display:grid; place-items:center; flex:none; width:24px; height:24px; border-radius:50%; background:var(--active-nav); color:var(--accent-strong); font-size:12px; font-weight:700; }
  ol li span { flex:1; }
  ol li button { flex:none; padding:5px 12px; }
  kbd { font-family:var(--font-mono); font-size:12px; padding:1px 5px; border:1px solid var(--line); border-radius:4px; }
  .all-done { margin:0; color:var(--theme-done); font-weight:650; }
</style>
