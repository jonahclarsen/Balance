<script lang="ts">
  import peacockTalking from '../assets/peacock-talking.png'
  import type { GoalDoabilityReview } from './goals'
  import OverlayModal from './OverlayModal.svelte'

  export let reviews: GoalDoabilityReview[]
  export let onClose: () => void
</script>

<OverlayModal title="Goal check-in" ariaLabel="Are your goals doable?" z={85} {onClose}>
  <div class="doability-review">
    <div class="mascot" aria-hidden="true">
      <img src={peacockTalking} alt="" />
    </div>

    <section class="guidance">
      <h2>Are your goals doable?</h2>
      <p>It's easy for the goal system to get clogged. From our experience, goals work best if they are typically:</p>
      <ul>
        <li>Able to be completed in 2–3 minutes (and can optionally go longer), unless it's a longer daily habit like a morning routine list</li>
        <li>Not dependent on someone else (“reach out to a friend to game” instead of “game with a friend”)</li>
        <li>Have a mandatory escape hatch for your attention (“draw for 2–10 minutes, then close Photoshop”)</li>
      </ul>
    </section>

    <section class="goals-to-review" aria-labelledby="goals-to-review-title">
      <h3 id="goals-to-review-title">Goals to review</h3>
      <ul>
        {#each reviews as review (review.goal.id)}
          <li>
            <span>{review.goal.name}</span>
            <strong>
              {review.days} {review.days === 1 ? 'day' : 'days'}
              {review.reason === 'missed-presentations' ? ' missed' : ' overdue'}
            </strong>
          </li>
        {/each}
      </ul>
    </section>
  </div>
</OverlayModal>

<style>
  .doability-review {
    display: grid;
    grid-template-columns: minmax(110px, 0.7fr) minmax(260px, 1.55fr) minmax(165px, 0.9fr);
    align-items: start;
    gap: 22px;
  }

  .mascot {
    align-self: center;
    overflow: hidden;
    border: 1px solid color-mix(in srgb, var(--line) 70%, transparent);
    border-radius: 18px;
    background: #faf8f2;
  }

  .mascot img {
    display: block;
    width: 100%;
    height: auto;
  }

  .guidance h2 {
    margin: 0 0 10px;
    color: var(--ink);
    font-size: clamp(21px, 2.4vw, 28px);
    line-height: 1.1;
  }

  .guidance p {
    margin: 0 0 12px;
    color: var(--muted);
    line-height: 1.45;
  }

  .guidance ul {
    margin: 0;
    padding-left: 20px;
    display: grid;
    gap: 9px;
    color: var(--ink);
    font-size: 13.5px;
    line-height: 1.4;
  }

  .goals-to-review {
    min-width: 0;
    padding: 14px;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--paper);
  }

  .goals-to-review h3 {
    margin: 0 0 10px;
    color: var(--muted);
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .goals-to-review ul {
    margin: 0;
    padding: 0;
    display: grid;
    gap: 9px;
    list-style: none;
  }

  .goals-to-review li {
    display: grid;
    gap: 2px;
    min-width: 0;
    padding-bottom: 9px;
    border-bottom: 1px solid var(--line);
  }

  .goals-to-review li:last-child {
    padding-bottom: 0;
    border-bottom: 0;
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
      grid-template-columns: 88px 1fr;
      gap: 16px;
    }

    .mascot {
      align-self: start;
    }

    .goals-to-review {
      grid-column: 1 / -1;
    }
  }

  @media (max-width: 420px) {
    .doability-review {
      grid-template-columns: 70px 1fr;
      gap: 12px;
    }

    .guidance ul {
      font-size: 13px;
    }
  }
</style>
