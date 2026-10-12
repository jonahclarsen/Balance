<script lang="ts">
  export let done: number
  export let total: number
  export let label: string

  $: percent = total === 0 ? 0 : Math.round((done / total) * 100)
</script>

<!-- Styled globally as .list-progress so themes can retint the fill. -->
<div
  class="list-progress"
  style={`--list-progress: ${percent}%`}
  role="progressbar"
  aria-label={label}
  aria-valuemin="0"
  aria-valuemax={total}
  aria-valuenow={done}
>
  <span class="list-progress-fill"></span>
</div>
