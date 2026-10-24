<script lang="ts">
  export let name:
    | 'next' | 'today' | 'templates' | 'listTemplates' | 'lists' | 'notes' | 'metrics'
    | 'goals' | 'projects' | 'prioritize' | 'ideas' | 'situate' | 'settings'
</script>
<svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
  {#if name === 'next'}<path d="M4 12h12M11 6l6 6-6 6M20 5v14" />
  {:else if name === 'today'}<circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
  {:else if name === 'templates'}<rect x="4" y="5" width="16" height="15" rx="2.5" /><path d="M4 10h16M8.5 3v4M15.5 3v4" />
  {:else if name === 'listTemplates'}<path d="M9.5 7h10M9.5 12h10M9.5 17h10M5 7h.01M5 12h.01M5 17h.01" />
  {:else if name === 'lists'}<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6M3.5 4v4.5H8M12 8v4l3 2" />
  {:else if name === 'notes'}<path d="M6 3h8.5L19 7.5V21H6zM14 3v5h5M9 13h7M9 17h5" />
  {:else if name === 'metrics'}<circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.4 2.3c-.6.3-.9.8-.9 1.4v.3M12 17h.01" />
  {:else if name === 'goals'}<circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><path d="M12 12h.01" />
  {:else if name === 'projects'}<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v7.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z" />
  {:else if name === 'prioritize'}<path d="M7 20V4M3.5 7.5 7 4l3.5 3.5M13 6h7M13 12h5M13 18h3" />
  {:else if name === 'ideas'}<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1 2V16h5.2v-.2c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z" />
  {:else if name === 'situate'}<circle cx="12" cy="12" r="9" /><path d="m15.5 8.5-2 5-5 2 2-5z" />
  {:else if name === 'settings'}<path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" />{/if}
</svg>
<style>.nav-icon { flex: none; width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; opacity: 0.8; }</style>
