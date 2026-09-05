<script lang="ts">
  export let checked = false
  export let disabled = false
  export let mobileCheckboxDragEnabled = false
  export let onPointerDown: (event: PointerEvent) => void = () => {}
  export let onContextMenu: (event: MouseEvent) => void = () => {}
  export let onClick: (event: MouseEvent) => void = () => {}
  export let onChange: (event: Event & { currentTarget: HTMLInputElement }) => void = () => {}
</script>

<label
  class="check-target"
  class:mobile-checkbox-drag-enabled={mobileCheckboxDragEnabled}
  title="Complete item"
  on:pointerdown={onPointerDown}
  on:contextmenu={onContextMenu}
>
  <input
    class="check"
    type="checkbox"
    {checked}
    {disabled}
    on:click={onClick}
    on:change={onChange}
    aria-label="Complete item"
  />
</label>
