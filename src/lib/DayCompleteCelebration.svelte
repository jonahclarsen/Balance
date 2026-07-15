<script lang="ts">
  // Fixed positions keep the burst lively while making it deterministic in
  // screenshots and tests. Each piece gets its own fall distance, delay, and
  // rotation so the shower does not read as a single repeated animation.
  const confetti = Array.from({ length: 32 }, (_, index) => ({
    x: `${4 + ((index * 29) % 92)}%`,
    drift: `${((index * 47) % 180) - 90}px`,
    delay: `${(index % 8) * 42}ms`,
    duration: `${1250 + ((index * 73) % 650)}ms`,
    rotation: `${180 + ((index * 137) % 540)}deg`,
    color: ['#f3b63f', '#e8695e', '#4da18f', '#6d82d8', '#d86fa8'][index % 5],
  }))
</script>

<div class="day-complete-celebration" role="status" aria-live="polite" aria-label="Day complete">
  <div class="confetti" aria-hidden="true">
    {#each confetti as piece}
      <i
        style={`--x: ${piece.x}; --drift: ${piece.drift}; --delay: ${piece.delay}; --duration: ${piece.duration}; --rotation: ${piece.rotation}; --confetti: ${piece.color}`}
      ></i>
    {/each}
  </div>

  <div class="completion-toast">
    <span class="sparkle" aria-hidden="true">✦</span>
    <strong>Day complete!</strong>
    <span>Everything checked. Nicely done.</span>
    <span class="sparkle second" aria-hidden="true">✦</span>
  </div>
</div>

<style>
  .day-complete-celebration {
    position: absolute;
    z-index: 80;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
  }

  .confetti {
    position: absolute;
    inset: 0;
  }

  .confetti i {
    position: absolute;
    top: -22px;
    left: var(--x);
    width: 9px;
    height: 15px;
    border-radius: 2px;
    background: var(--confetti);
    opacity: 0;
    animation: confetti-fall var(--duration) cubic-bezier(0.2, 0.7, 0.35, 1) var(--delay) both;
  }

  .confetti i:nth-child(3n) {
    width: 7px;
    height: 7px;
    border-radius: 50%;
  }

  .confetti i:nth-child(4n) {
    width: 13px;
    height: 6px;
  }

  .completion-toast {
    position: absolute;
    top: clamp(105px, 21%, 180px);
    left: 50%;
    display: grid;
    grid-template-columns: auto auto auto;
    align-items: center;
    column-gap: 9px;
    min-width: min(360px, calc(100% - 32px));
    border: 1px solid color-mix(in srgb, var(--accent) 55%, var(--line));
    border-radius: 999px;
    padding: 13px 22px;
    background: color-mix(in srgb, var(--paper-strong) 94%, transparent);
    box-shadow: 0 18px 50px rgba(24, 43, 38, 0.22);
    color: var(--ink);
    text-align: center;
    backdrop-filter: blur(8px);
    transform: translateX(-50%);
    animation: toast-arrive 2800ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
  }

  .completion-toast strong {
    font-size: 17px;
    white-space: nowrap;
  }

  .completion-toast strong + span {
    grid-column: 2;
    color: var(--muted);
    font-size: 12px;
  }

  .sparkle {
    grid-row: 1 / span 2;
    color: #e3a52d;
    font-size: 20px;
    animation: sparkle-spin 900ms ease-out 120ms both;
  }

  .sparkle.second {
    grid-column: 3;
  }

  @keyframes confetti-fall {
    0% {
      opacity: 0;
      transform: translate3d(0, -12px, 0) rotate(0deg);
    }

    8% {
      opacity: 1;
    }

    100% {
      opacity: 0;
      transform: translate3d(var(--drift), calc(100vh + 40px), 0) rotate(var(--rotation));
    }
  }

  @keyframes toast-arrive {
    0% {
      opacity: 0;
      transform: translate(-50%, -14px) scale(0.92);
    }

    12%,
    78% {
      opacity: 1;
      transform: translate(-50%, 0) scale(1);
    }

    100% {
      opacity: 0;
      transform: translate(-50%, -5px) scale(0.98);
    }
  }

  @keyframes sparkle-spin {
    from {
      opacity: 0;
      transform: scale(0.4) rotate(-100deg);
    }

    to {
      opacity: 1;
      transform: scale(1) rotate(0);
    }
  }

  @media (max-width: 520px) {
    .completion-toast {
      top: 94px;
      min-width: 0;
      width: calc(100% - 28px);
      padding-inline: 16px;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .confetti {
      display: none;
    }

    .completion-toast,
    .sparkle {
      animation: none;
    }
  }
</style>
