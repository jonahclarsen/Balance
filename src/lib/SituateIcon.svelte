<script lang="ts">
  export let name: 'mac' | 'android' | 'windows' | 'domain' | 'app' | 'discord'
  export let size = 16
</script>
<svg class="situate-icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
  {#if name === 'android'}<rect x="7" y="2.5" width="10" height="19" rx="2.5" /><path d="M11 18.5h2" />
  {:else if name === 'domain'}<circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z" />
  {:else if name === 'app'}<rect x="4" y="4" width="16" height="16" rx="4.5" /><path d="M9 12h6" />
  {:else if name === 'discord'}<path d="M9 4 7 20M17 4l-2 16M4.5 9h16M3.5 15h16" />
  {:else}<rect x="4" y="5" width="16" height="11" rx="1.8" /><path d="M2 19h20" />{/if}
</svg>
<style>.situate-icon { flex:none; fill:none; stroke:currentColor; stroke-width:1.7; stroke-linecap:round; stroke-linejoin:round; }</style>
