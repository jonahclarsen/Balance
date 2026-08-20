export type CompletionCelebrationCategory = 'pretty' | 'funny' | 'culture' | 'ui' | 'trippy' | 'maximum'

export type CompletionCelebrationEngine =
  | 'atmosphere'
  | 'particles'
  | 'character'
  | 'collage'
  | 'geometry'
  | 'ui'
  | 'psychedelic'

export type CompletionCelebrationDefinition = {
  id: string
  name: string
  description: string
  icon: string
  category: CompletionCelebrationCategory
  engine: CompletionCelebrationEngine
  recipe: string
  durationMs: number
  intensity: 1 | 2 | 3 | 4 | 5
  palette: readonly [string, string, string]
}

export const COMPLETION_CELEBRATIONS = [
  {
    id: 'aurora-checkwave',
    name: 'Aurora Checkwave',
    description: 'Your finished day exhales a slow curtain of northern-light color.',
    icon: '🌌', category: 'pretty', engine: 'atmosphere', recipe: 'aurora', durationMs: 3600, intensity: 2,
    palette: ['#71e5c6', '#7d8cff', '#e187ff'],
  },
  {
    id: 'dandelion-done',
    name: 'Dandelion Done',
    description: 'Every checkbox becomes a seed and floats off to take tomorrow off.',
    icon: '🌬️', category: 'pretty', engine: 'particles', recipe: 'dandelion', durationMs: 3200, intensity: 2,
    palette: ['#fff4bd', '#f2d780', '#f9faf2'],
  },
  {
    id: 'constellation-closure',
    name: 'Constellation Closure',
    description: "Tonight's tasks connect into a tiny constellation that only exists once.",
    icon: '✨', category: 'pretty', engine: 'geometry', recipe: 'constellation', durationMs: 4000, intensity: 2,
    palette: ['#a6c8ff', '#f8e7a1', '#7668d8'],
  },
  {
    id: 'bioluminescent-tide',
    name: 'Bioluminescent Tide',
    description: 'A midnight tide rolls in, and every completed task glows when it touches the water.',
    icon: '🪼', category: 'pretty', engine: 'particles', recipe: 'bioluminescence', durationMs: 4000, intensity: 3,
    palette: ['#16e0d0', '#4477ff', '#c46cff'],
  },
  {
    id: 'stained-glass-sunrise',
    name: 'Stained-Glass Sunrise',
    description: 'The day cracks into jewel-colored panes, then sunrise shines through.',
    icon: '🌅', category: 'pretty', engine: 'geometry', recipe: 'stained-glass', durationMs: 3400, intensity: 3,
    palette: ['#ef476f', '#ffd166', '#118ab2'],
  },
  {
    id: 'moonlit-fireflies',
    name: 'Moonlit Fireflies',
    description: 'Quiet little lights gather around the last checkmark, then wander home.',
    icon: '🌙', category: 'pretty', engine: 'particles', recipe: 'fireflies', durationMs: 4500, intensity: 1,
    palette: ['#ffe889', '#8bd3dd', '#28326b'],
  },
  {
    id: 'deadline-goose',
    name: 'Deadline Goose',
    description: 'A goose steals the final deadline and honks offscreen. No follow-up questions.',
    icon: '🪿', category: 'funny', engine: 'character', recipe: 'goose', durationMs: 3800, intensity: 3,
    palette: ['#f7f4e8', '#f1a93b', '#5f88b8'],
  },
  {
    id: 'tiny-janitor',
    name: 'Tiny Janitor',
    description: 'Management sent one extremely small employee to sweep away the remaining stress.',
    icon: '🧹', category: 'funny', engine: 'character', recipe: 'janitor', durationMs: 5000, intensity: 2,
    palette: ['#f6c453', '#64a6bd', '#7a5c45'],
  },
  {
    id: 'department-of-done',
    name: 'Department of Done',
    description: 'Your paperwork was reviewed and found suspiciously complete.',
    icon: '🗃️', category: 'funny', engine: 'collage', recipe: 'approved', durationMs: 2800, intensity: 3,
    palette: ['#c43131', '#f4e7ce', '#243443'],
  },
  {
    id: 'task-toaster',
    name: 'Task Toaster',
    description: 'The plan is toast—in the positive, butter-adjacent sense.',
    icon: '🍞', category: 'funny', engine: 'character', recipe: 'toaster', durationMs: 3500, intensity: 3,
    palette: ['#f4b860', '#dc7f35', '#fff2cf'],
  },
  {
    id: 'victory-roomba',
    name: 'Victory Roomba',
    description: "A tiny robot vacuums up the day's leftover chaos and bonks into the sidebar once.",
    icon: '🤖', category: 'funny', engine: 'character', recipe: 'roomba', durationMs: 4200, intensity: 2,
    palette: ['#44515d', '#54d6c3', '#ef6f6c'],
  },
  {
    id: 'checkbox-chorus-line',
    name: 'Checkbox Chorus Line',
    description: 'The checkboxes have unionized, rehearsed, and prepared a tiny finale.',
    icon: '👯', category: 'funny', engine: 'character', recipe: 'chorus', durationMs: 3900, intensity: 3,
    palette: ['#ff5d8f', '#ffd166', '#5b4b8a'],
  },
  {
    id: 'hokusai-task-tide',
    name: 'Hokusai Task Tide',
    description: 'Layered indigo waves curl over the day and leave every task sparkling clean.',
    icon: '🌊', category: 'culture', engine: 'atmosphere', recipe: 'woodblock-wave', durationMs: 4000, intensity: 4,
    palette: ['#163a70', '#2774ae', '#e8dfc8'],
  },
  {
    id: 'papel-picado-breeze',
    name: 'Papel Picado Breeze',
    description: 'A bright cut-paper banner arrives because finished days deserve decorations.',
    icon: '🎏', category: 'culture', engine: 'collage', recipe: 'papel-picado', durationMs: 4200, intensity: 2,
    palette: ['#ef476f', '#06d6a0', '#ffd166'],
  },
  {
    id: 'infinite-tile-garden',
    name: 'Infinite Tile Garden',
    description: 'Stars and crosses tessellate outward until the whole day finds geometric balance.',
    icon: '✳️', category: 'culture', engine: 'geometry', recipe: 'tile-garden', durationMs: 4400, intensity: 4,
    palette: ['#075985', '#14b8a6', '#d6a84b'],
  },
  {
    id: 'dada-receipt-storm',
    name: 'Dada Receipt Storm',
    description: 'A receipt declares: 1 DAY, 100% DONE, LOGIC OPTIONAL.',
    icon: '🧾', category: 'culture', engine: 'collage', recipe: 'dada-receipt', durationMs: 3700, intensity: 3,
    palette: ['#f5efe1', '#e63946', '#111111'],
  },
  {
    id: 'domino-day',
    name: 'Domino Day',
    description: 'The task cards tip like dominoes, then politely stand themselves back up.',
    icon: '🁢', category: 'ui', engine: 'ui', recipe: 'domino', durationMs: 3000, intensity: 3,
    palette: ['#f7f7f2', '#20232a', '#2f9f91'],
  },
  {
    id: 'gravity-is-optional',
    name: 'Gravity Is Optional',
    description: 'The interface floats for a moment, then remembers it has responsibilities.',
    icon: '🪐', category: 'ui', engine: 'ui', recipe: 'zero-gravity', durationMs: 4500, intensity: 4,
    palette: ['#7c5cff', '#58d5e8', '#ff8ac6'],
  },
  {
    id: 'task-zipper',
    name: 'Task Zipper',
    description: 'The day zips itself closed with one extremely official check-shaped pull tab.',
    icon: '🤐', category: 'ui', engine: 'ui', recipe: 'zipper', durationMs: 3600, intensity: 3,
    palette: ['#f3c969', '#465362', '#f6f2e9'],
  },
  {
    id: 'curtain-call',
    name: 'Curtain Call',
    description: 'Your tasks take a bow while velvet curtains insist this was all prestigious.',
    icon: '🎭', category: 'ui', engine: 'ui', recipe: 'curtain', durationMs: 4200, intensity: 3,
    palette: ['#8e1838', '#d9ad53', '#321228'],
  },
  {
    id: 'interface-inhale',
    name: 'Interface Inhale',
    description: 'Everything breathes in, breathes out, and finds there is nothing left to do.',
    icon: '🫧', category: 'ui', engine: 'ui', recipe: 'inhale', durationMs: 3500, intensity: 2,
    palette: ['#9ce5d8', '#c5b3ff', '#f9cae5'],
  },
  {
    id: 'op-art-victory-pulse',
    name: 'Op-Art Victory Pulse',
    description: 'Black-and-white geometry bends around one impossible, extremely colorful check.',
    icon: '◉', category: 'trippy', engine: 'psychedelic', recipe: 'op-art', durationMs: 3800, intensity: 4,
    palette: ['#101010', '#f6f6f0', '#ff3cac'],
  },
  {
    id: 'liquid-chrome',
    name: 'Liquid Chrome',
    description: 'Impossible chrome eats the empty to-do space and reflects a tiny rainbow.',
    icon: '🫠', category: 'trippy', engine: 'psychedelic', recipe: 'chrome', durationMs: 4000, intensity: 4,
    palette: ['#dce6ef', '#6f7f91', '#e66bff'],
  },
  {
    id: 'kaleidoscope-checkbox',
    name: 'Kaleidoscope Checkbox',
    description: 'One checkbox reflects into a tiny universe with suspiciously good symmetry.',
    icon: '🔮', category: 'trippy', engine: 'psychedelic', recipe: 'kaleidoscope', durationMs: 4400, intensity: 5,
    palette: ['#ff4ecd', '#45f3ff', '#ffe14d'],
  },
  {
    id: 'chromatic-echo',
    name: 'Chromatic Echo',
    description: 'The interface leaves RGB ghosts of itself, then snaps into perfect focus.',
    icon: '🫨', category: 'trippy', engine: 'psychedelic', recipe: 'chromatic-echo', durationMs: 2800, intensity: 4,
    palette: ['#ff2851', '#22e39f', '#287cff'],
  },
  {
    id: 'reaction-diffusion-bloom',
    name: 'Reaction-Diffusion Bloom',
    description: 'Organic spots grow from every check like microscopic alien weather.',
    icon: '🦠', category: 'trippy', engine: 'psychedelic', recipe: 'reaction-bloom', durationMs: 4800, intensity: 5,
    palette: ['#bef264', '#14b8a6', '#7c3aed'],
  },
  {
    id: 'infinite-feedback-cathedral',
    name: 'Infinite Feedback Cathedral',
    description: 'The day falls through a neon tunnel made from echoes of its own interface.',
    icon: '🌀', category: 'maximum', engine: 'psychedelic', recipe: 'feedback-tunnel', durationMs: 5000, intensity: 5,
    palette: ['#ff2bd6', '#28e7ff', '#7dff58'],
  },
  {
    id: 'event-horizon',
    name: 'Event Horizon',
    description: 'Every unfinished possibility collapses into a black hole; one radiant check escapes.',
    icon: '🕳️', category: 'maximum', engine: 'psychedelic', recipe: 'event-horizon', durationMs: 4600, intensity: 5,
    palette: ['#05040a', '#a855f7', '#ffb347'],
  },
  {
    id: 'ui-mitosis',
    name: 'UI Mitosis',
    description: 'Baby interfaces check microscopic tasks, orbit once, and merge into the mothership.',
    icon: '🧬', category: 'maximum', engine: 'ui', recipe: 'mitosis', durationMs: 5000, intensity: 5,
    palette: ['#4cc9f0', '#f72585', '#b8f2a1'],
  },
  {
    id: 'layout-poltergeist',
    name: 'Layout Poltergeist',
    description: 'The panes leave their assigned seats, orbit the room, and return pretending nothing happened.',
    icon: '👁️', category: 'maximum', engine: 'ui', recipe: 'poltergeist', durationMs: 5200, intensity: 5,
    palette: ['#70ffba', '#7f36ff', '#ff477e'],
  },
  {
    id: 'non-euclidean-office',
    name: 'Non-Euclidean Office',
    description: 'The sidebar becomes a ceiling and the task list takes a shortcut through impossible geometry.',
    icon: '📐', category: 'maximum', engine: 'ui', recipe: 'non-euclidean', durationMs: 5400, intensity: 5,
    palette: ['#18f2ff', '#ff3fd1', '#f4ff52'],
  },
  {
    id: 'recursive-ui-fever',
    name: 'Recursive UI Fever',
    description: 'Balance dreams about Balance dreaming about Balance until the checks wake it up.',
    icon: '🪞', category: 'maximum', engine: 'psychedelic', recipe: 'recursive-fever', durationMs: 5600, intensity: 5,
    palette: ['#ff2a9d', '#00f0ff', '#b6ff35'],
  },
  {
    id: 'reality-buffer-overflow',
    name: 'Reality Buffer Overflow',
    description: 'The interface desynchronizes into moving slabs, briefly exceeds reality, and hard-snaps home.',
    icon: '📺', category: 'maximum', engine: 'ui', recipe: 'buffer-overflow', durationMs: 5000, intensity: 5,
    palette: ['#ff335f', '#24ffd1', '#7950ff'],
  },
  {
    id: 'app-demands-applause',
    name: 'The App Demands Applause',
    description: 'Balance informs the operating system that this achievement concerns everyone.',
    icon: '👏', category: 'maximum', engine: 'ui', recipe: 'applause', durationMs: 3400, intensity: 5,
    palette: ['#f4b942', '#ef6f6c', '#2f6f68'],
  },
] as const satisfies readonly CompletionCelebrationDefinition[]

export type CompletionCelebrationId = (typeof COMPLETION_CELEBRATIONS)[number]['id']

export const DEFAULT_COMPLETION_CELEBRATION_ID: CompletionCelebrationId = 'aurora-checkwave'

const COMPLETION_CELEBRATIONS_BY_ID = new Map<CompletionCelebrationId, (typeof COMPLETION_CELEBRATIONS)[number]>(
  COMPLETION_CELEBRATIONS.map((celebration) => [celebration.id, celebration]),
)

export function normalizeCompletionCelebrationId(value: unknown): CompletionCelebrationId {
  return typeof value === 'string' && COMPLETION_CELEBRATIONS_BY_ID.has(value as CompletionCelebrationId)
    ? value as CompletionCelebrationId
    : DEFAULT_COMPLETION_CELEBRATION_ID
}

export function getCompletionCelebration(id: CompletionCelebrationId) {
  return COMPLETION_CELEBRATIONS_BY_ID.get(id) ?? COMPLETION_CELEBRATIONS[0]
}
