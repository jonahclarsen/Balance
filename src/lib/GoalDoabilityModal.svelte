<script lang="ts">
  import peacockTalking from '../assets/peacock-talking.png'
  import type { GoalDoabilityReview } from './goals'
  import type { Id } from './types'
  import OverlayModal from './OverlayModal.svelte'

  export let reviews: GoalDoabilityReview[]
  export let onClose: () => void
  export let onSelectGoal: (goalId: Id) => void

</script>

<OverlayModal
  ariaLabel="Are your goals attainable?"
  z={85}
  maxWidth={1096}
  height={705}
  bodyOverflow="hidden"
  headerless
  {onClose}
>
  <div class="doability-review">
    <div class="review-layout">
      <section class="guidance">
        <div class="mascot-stack">
          <div class="mascot" aria-hidden="true">
            <img src={peacockTalking} alt="" />
          </div>
        </div>
        <h2>Are your goals attainable?</h2>
        <p>It's easy for the goal system to get clogged. From our experience, goals work best when they are:</p>
        <ul>
          <li>Able to be completed in 2–3 minutes (and can optionally go longer), unless it's a longer daily habit like a morning routine list</li>
          <li>Not dependent on someone else (“reach out to a friend to game” instead of “game with a friend”)</li>
          <li>Have a mandatory escape hatch for your attention (“draw for 2–10 minutes, then close Photoshop”)</li>
        </ul>
      </section>

      <section class="goals-to-review" aria-label="Goals to review">
        <ul>
          {#each reviews as review (review.goal.id)}
            <li>
              <button
                type="button"
                aria-label={`Review ${review.goal.name}: ${review.days} ${review.days === 1 ? 'day' : 'days'} ${review.reason === 'missed-presentations' ? 'missed' : 'overdue'}`}
                on:click={() => onSelectGoal(review.goal.id)}
              >
                <span>{review.goal.name}</span>
                <strong>
                  {review.days} {review.days === 1 ? 'day' : 'days'}
                  {review.reason === 'missed-presentations' ? ' missed' : ' overdue'}
                </strong>
              </button>
            </li>
          {/each}
        </ul>
      </section>
    </div>
  </div>
</OverlayModal>

<style>
  .doability-review {
    height: 100%;
    min-height: 0;
  }

  .review-layout {
    display: grid;
    grid-template-columns: minmax(360px, 639fr) minmax(180px, 407fr);
    align-items: stretch;
    gap: 12px;
    height: 100%;
    min-width: 0;
    min-height: 0;
  }

  .mascot {
    height: 393px;
    max-width: 100%;
  }

  .mascot img {
    display: block;
    width: auto;
    max-width: 100%;
    height: 100%;
    margin: 0 auto;
    object-fit: contain;
  }

  .mascot-stack {
    display: grid;
    justify-items: center;
    margin: 0 auto 6px;
  }

  .guidance h2 {
    margin: 0 0 10px;
    color: var(--ink);
    font-size: clamp(21px, 2.4vw, 28px);
    line-height: 1.1;
  }

  .guidance {
    min-width: 0;
    min-height: 0;
    padding: 0 18px;
    overflow-y: auto;
  }

  .guidance p {
    margin: 0 0 12px;
    color: var(--muted);
    font-size: 17px;
    line-height: 1.45;
  }

  .guidance ul {
    margin: 0;
    padding-left: 20px;
    display: grid;
    gap: 9px;
    color: var(--ink);
    font-size: 15.5px;
    line-height: 1.4;
  }

  .goals-to-review {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    padding: 42px 14px 14px;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--paper);
  }

  .goals-to-review ul {
    min-height: 0;
    margin: 0;
    padding: 0;
    display: grid;
    align-content: start;
    gap: 9px;
    list-style: none;
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-gutter: stable;
  }

  .goals-to-review li {
    min-width: 0;
    padding-bottom: 9px;
    border-bottom: 1px solid var(--line);
  }

  .goals-to-review li:last-child {
    padding-bottom: 0;
    border-bottom: 0;
  }

  .goals-to-review button {
    width: 100%;
    padding: 2px 4px;
    display: grid;
    gap: 2px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    text-align: left;
  }

  .goals-to-review button:hover,
  .goals-to-review button:focus-visible {
    background: var(--active-nav);
  }

  .goals-to-review span {
    overflow-wrap: anywhere;
    color: var(--ink);
    font-size: 13.5px;
    font-weight: 650;
  }

  .goals-to-review strong {
    color: var(--muted);
    font-size: 12px;
    font-weight: 550;
  }

  @media (max-width: 760px) {
    .doability-review {
      gap: 8px;
    }

    .review-layout {
      grid-template-columns: 1fr !important;
      grid-template-rows: minmax(0, auto) minmax(120px, 1fr);
      gap: 16px;
      padding-top: 24px;
    }

    .mascot {
      max-height: 180px;
    }

    .goals-to-review {
      padding-top: 14px;
    }

  }

  @media (max-width: 420px) {
    .review-layout {
      gap: 12px;
    }

    .guidance ul {
      font-size: 15px;
    }
  }
</style>
