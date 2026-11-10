<script lang="ts">
  import { IDEA_GROUPS } from './ideas'
  import type { IdeaGroupKind } from './types'

  // A short-lived full-window effect for the existing sorting dialog.
  // All movement is local SVG transforms; no inherited theme tokens animate.
  export let source: HTMLElement | null = null
  export let sourceRect: DOMRect | null = null
  export let text: string
  export let destination: IdeaGroupKind
  export let label: string
  export let progress: number
  export let distribution: number[]

  const columns = 24
  const rows = 11
  const seed = Array.from(text).reduce((value, character) => (value * 31 + character.codePointAt(0)!) >>> 0, 7)
  function numberAt(index: number) {
    let value = seed ^ Math.imul(index + 1, 0x45d9f3b)
    value = Math.imul(value ^ (value >>> 16), 0x45d9f3b)
    return ((value ^ (value >>> 16)) >>> 0) % 10
  }
  const digits = Array.from({ length: columns * rows }, (_, i) => ({
    value: numberAt(i),
    x: 38 + (i % columns) * 40.2,
    y: 106 + Math.floor(i / columns) * 38,
  }))
  // Spread the entire captured dialog surface into a field of numeric fragments.
  const rect = sourceRect ?? new DOMRect(0, 0, innerWidth, innerHeight)
  const letters = Array.from({ length: 120 }, (_, i) => ({
    character: '', number: numberAt(i + 300),
    x: (rect.left + ((i % 15) + .5) * rect.width / 15) / innerWidth * 1000,
    y: (rect.top + (Math.floor(i / 15) + .5) * rect.height / 8) / innerHeight * 640,
    clusterX: 500 + ((i % 15) - 7) * 24,
    clusterY: 230 + Math.floor(i / 15) * 18,
  }))

  function takeOver(node: HTMLElement) {
    const backdrop = document.querySelector<HTMLElement>('.idea-sort[role="dialog"]')?.closest<HTMLElement>('.overlay-backdrop')
    const visibility = backdrop?.style.visibility ?? ''
    if (backdrop) backdrop.style.visibility = 'hidden'
    document.body.append(node)
    if (source) for (let i = 0; i < 16; i++) {
      const strip = document.createElement('div')
      Object.assign(strip.style, {
        position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`,
        width: `${rect.width}px`, height: `${rect.height}px`, pointerEvents: 'none',
        clipPath: `inset(${i * 6.25}% 0 ${100 - (i + 1) * 6.25}% 0)`,
      })
      const copy = source.cloneNode(true) as HTMLElement
      copy.removeAttribute('role')
      copy.inert = true
      Object.assign(copy.style, { width: '100%', height: '100%', maxHeight: 'none', transform: 'none', visibility: 'visible' })
      strip.append(copy)
      node.append(strip)
      strip.animate([
        { transform: 'translate(0,0) scaleX(1)', opacity: 1 },
        { transform: `translate(${(i % 2 ? 1 : -1) * 24}px,${(i - 8) * 4}px) scaleX(.96)`, opacity: .85, offset: .55 },
        { transform: `translate(${(i % 2 ? 1 : -1) * 70}px,${(i - 8) * 9}px) scaleX(.6)`, opacity: 0 },
      ], { duration: 350, delay: i * 7, fill: 'both', easing: 'cubic-bezier(.3,0,.6,1)' })
    }
    return { destroy() { node.remove(); if (backdrop) backdrop.style.visibility = visibility } }
  }
  const target = IDEA_GROUPS.findIndex((group) => group.kind === destination)
  const targetX = 108 + target * 196
  const hex = (value: number) => `0x${value.toString(16).toUpperCase().padStart(6, '0').slice(-6)}`
</script>

<div use:takeOver class="refinement" aria-hidden="true" data-destination={destination}>
  <svg preserveAspectRatio="none" viewBox="0 0 1000 640" fill="none" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <pattern id="refinement-scanlines" width="4" height="4" patternUnits="userSpaceOnUse">
        <path d="M0 3.5H4" stroke="currentColor" stroke-opacity=".045" />
      </pattern>
    </defs>
    <path class="rule" d="M16 21H816V63H16ZM0 76H1000M0 81H1000M0 512H1000M0 517H1000" />
    <text class="file-name" x="30" y="50">Ideas</text>
    <g class="completion-ticks">
      {#each Array.from({ length: 45 }) as _, i}
        <path d={`M${165 + i * 9} 25V59`} opacity={i / 45 < progress ? 1 : .12} />
      {/each}
    </g>
    <text class="completion" x="800" y="50" text-anchor="end">{Math.round(progress * 100)}% Complete</text>
    <g class="wordmark">
      <ellipse cx="910" cy="42" rx="74" ry="30" />
      <path d="M838 34H982M838 50H982M910 12C867 18 867 66 910 72M910 12C953 18 953 66 910 72" />
      <rect class="paper" x="840" y="30" width="140" height="24" stroke="none" />
      <text x="910" y="50" text-anchor="middle">BALANCE</text>
    </g>
    <g class="number-field">
      {#each digits as digit, i}
        <!-- Clear the idea's two lines without a separate card or text plaque. -->
        {#if !(digit.x > 190 && digit.x < 810 && digit.y > 470)}
          <g class:replenish={digit.x > 206 && digit.x < 794 && digit.y > 230 && digit.y < 340}>
            <text x={digit.x} y={digit.y} style={`--drift: ${i % 2 ? 2 : -2}px; --offset: ${-(i % 9) * 80}ms`}>{digit.value}</text>
          </g>
        {/if}
      {/each}
    </g>
    <path class="selection" d="M211 239h-16v17M789 239h16v17M211 329h-16v-17M789 329h16v-17" />
    {#each letters as letter, i}
      <g
        class="fragment"

        style={`--start-x:${letter.x}px; --start-y:${letter.y}px; --cluster-x:${letter.clusterX}px; --cluster-y:${letter.clusterY}px; --bend-x:${targetX + (letter.clusterX - 500) * .6}px; --bend-y:${398 + (i % 5) * 7}px; --target-x:${targetX + ((i % 3) - 1) * 9}px; --delay:${(i % 7) * 12}ms`}
      >
        <text class="letter">{letter.character}</text>
        <text class="encoded">{letter.number}</text>
      </g>
    {/each}
    <text class="destination" x="500" y="493" text-anchor="middle">{label}</text>
    {#each IDEA_GROUPS as group, i}
      {@const x = 28 + i * 196}
      <g class="bin" class:receiving={i === target}>
        <rect class="bin-surface" x={x - 8} y="525" width="176" height="90" rx="5" />
        <path class="lid lid-left" d={`M${x} 531h80`} style={`transform-origin:${x}px 531px`} />
        <path class="lid lid-right" d={`M${x + 80} 531h80`} style={`transform-origin:${x + 160}px 531px`} />
        <path class="rule" d={`M${x} 535h160v36H${x}ZM${x} 580h160v28H${x}Z`} />
        <text class="bin-number" x={x + 80} y="561" text-anchor="middle">0{i + 1}</text>
        <rect class="bin-fill" x={x + 3} y="583" width={Math.max(0, distribution[i]! * 154)} height="22" />
        <text class="bin-percent" x={x + 9} y="601">{Math.round(distribution[i]! * 100)}%</text>
      </g>
    {/each}
    <text class="address" x="500" y="634" text-anchor="middle">{hex(seed)} : {hex(seed ^ 0x137056)}</text>
    <rect width="1000" height="640" fill="url(#refinement-scanlines)" />
  </svg>
</div>

<style>
  .refinement {
    position: fixed;
    inset: 0;
    z-index: 10000;
    display: grid;
    place-items: center;
    overflow: hidden;
    pointer-events: auto;
    color: var(--accent-strong);
    background: transparent;
    animation: terminal-shutter 1320ms linear both;
  }
  svg { background: transparent; animation: field-open 1320ms linear both; display: block; width: 100%; height: 100%; overflow: hidden; }
  text { fill: currentColor; font-family: var(--font-mono); font-weight: 500; }
  .paper { fill: var(--paper-strong); }
  .rule, .wordmark, .selection, .lid { stroke: currentColor; stroke-width: 2; }
  .file-name { font-size: 28px; font-weight: 700; }
  .completion { font-size: 26px; }
  .completion-ticks { stroke: currentColor; stroke-width: 4; }
  .wordmark text { font-size: 24px; font-weight: 800; stroke: none; }
  .number-field text {
    font-size: 20px;
    text-anchor: middle;
    animation: number-float 1400ms ease-in-out infinite alternate;
    animation-delay: var(--offset);
    opacity: .24;
  }
  .selection {
    stroke-dasharray: 33;
    transform-box: fill-box;
    transform-origin: center;
    animation: select-cluster 1320ms linear both;
  }
  .fragment {
    transform: translate(var(--start-x), var(--start-y));
    animation: refine-fragment 1050ms cubic-bezier(.45, 0, .3, 1) both;
    animation-delay: var(--delay);
  }
  .fragment text { text-anchor: middle; font-size: 26px; }
  .fragment .encoded { font-size: 22px; }
  .replenish { animation: refill-field 1320ms steps(1) both; }
  .letter { animation: encode-letter 1320ms steps(1) both; animation-delay: var(--delay); }
  .encoded { animation: encode-number 1320ms steps(1) both; animation-delay: var(--delay); }
  .destination { font-size: 22px; animation: destination-arrive 1320ms steps(1) both; }
  .bin-surface { fill: var(--paper-strong); fill-opacity: .92; }
  .bin-number { font-size: 26px; font-weight: 700; }
  .bin-percent { font-size: 22px; paint-order: stroke; stroke: var(--paper-strong); stroke-width: 3px; }
  .bin-fill { fill: currentColor; opacity: .25; }
  .receiving .bin-fill { animation: receive-fill 1320ms ease both; transform-box: fill-box; transform-origin: left; }
  .lid { transform: rotate(0deg); }
  .receiving .lid-left { animation: open-left 1320ms ease both; }
  .receiving .lid-right { animation: open-right 1320ms ease both; }
  .address { font-size: 20px; }

  /* Horizontal scan opens into the field; the closing iris folds vertically,
     then retracts to a point. No generic opacity transition on the surface. */
  @keyframes terminal-shutter {
    0%, 85% { clip-path: inset(0 0); }
    95% { clip-path: inset(49.8% 0); }
    100% { clip-path: inset(49.8% 50%); }
  }
  @keyframes field-open { 0% { clip-path: inset(49.8% 0); } 20%, 100% { clip-path: inset(0); } }
  @keyframes number-float { to { transform: translateY(var(--drift)); } }
  @keyframes refill-field { 0% { opacity: 0; } 54%, 100% { opacity: 1; } }
  @keyframes select-cluster {
    0%, 20% { stroke-dashoffset: 33; opacity: 0; }
    30% { stroke-dashoffset: 0; opacity: 1; transform: scale(1); }
    43% { stroke-dashoffset: 0; opacity: 1; transform: scale(.26, 1.3); }
    52%, 100% { stroke-dashoffset: 33; opacity: 0; }
  }
  @keyframes encode-letter { 0% { opacity: 1; } 27%, 100% { opacity: 0; } }
  @keyframes encode-number { 0% { opacity: 0; } 15%, 100% { opacity: 1; } }
  @keyframes merge-number { 0% { opacity: 0; } 27% { opacity: 1; } 43%, 100% { opacity: 0; } }
  @keyframes refine-fragment {
    0%, 32% { transform: translate(var(--start-x), var(--start-y)); opacity: 1; }
    53% { transform: translate(var(--cluster-x), var(--cluster-y)); opacity: 1; }
    76% { transform: translate(var(--bend-x), var(--bend-y)); opacity: 1; }
    97% { transform: translate(var(--target-x), 555px) scale(.45); opacity: 1; }
    100% { transform: translate(var(--target-x), 565px) scale(.2); opacity: 0; }
  }
  @keyframes destination-arrive { 0% { opacity: 0; } 43%, 100% { opacity: 1; } }
  @keyframes open-left { 0%, 40%, 84%, 100% { transform: rotate(0); } 55%, 76% { transform: rotate(-42deg); } }
  @keyframes open-right { 0%, 40%, 84%, 100% { transform: rotate(0); } 55%, 76% { transform: rotate(42deg); } }
  @keyframes receive-fill { 0%, 72% { transform: scaleX(.7); } 84%, 100% { transform: scaleX(1); } }


</style>
