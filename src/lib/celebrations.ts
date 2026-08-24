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
    id: 'stained-glass-sunrise',
    name: 'Stained-Glass Sunrise',
    description: 'The day cracks into jewel-colored panes, then sunrise shines through.',
    icon: '🌅', category: 'pretty', engine: 'geometry', recipe: 'stained-glass', durationMs: 3400, intensity: 3,
    palette: ['#ef476f', '#ffd166', '#118ab2'],
  },
  {
    id: 'bell-of-now',
    name: 'Bell of Now',
    description: 'One clear bell sends gentle ripples through this finished moment: here, now.',
    icon: '🔔', category: 'pretty', engine: 'atmosphere', recipe: 'bell-of-now', durationMs: 4200, intensity: 1,
    palette: ['#d7b66d', '#6f8f83', '#f4ead4'],
  },
  {
    id: 'loving-kindness-ripple',
    name: 'Loving-Kindness Ripple',
    description: 'A warm wish travels outward: may I be well, may you be well, may all be well.',
    icon: '💗', category: 'pretty', engine: 'atmosphere', recipe: 'metta-ripple', durationMs: 4800, intensity: 1,
    palette: ['#e8899d', '#f1bd87', '#fff0dc'],
  },
  {
    id: 'enough-for-today',
    name: 'Enough for Today',
    description: 'A small flame settles beside a quiet reminder: this day was lived, and it is enough.',
    icon: '🕯️', category: 'pretty', engine: 'atmosphere', recipe: 'enough', durationMs: 4400, intensity: 1,
    palette: ['#f0a45d', '#8d6f68', '#f7e6c8'],
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
    id: 'interface-inhale',
    name: 'Interface Inhale',
    description: 'Everything breathes in, breathes out, and finds there is nothing left to do.',
    icon: '🫧', category: 'ui', engine: 'ui', recipe: 'inhale', durationMs: 3500, intensity: 2,
    palette: ['#9ce5d8', '#c5b3ff', '#f9cae5'],
  },
  {
    id: 'infinite-feedback-cathedral',
    name: 'Infinite Feedback Cathedral',
    description: 'The day falls through a neon tunnel made from echoes of its own interface.',
    icon: '🌀', category: 'maximum', engine: 'psychedelic', recipe: 'feedback-tunnel', durationMs: 5000, intensity: 5,
    palette: ['#ff2bd6', '#28e7ff', '#7dff58'],
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

export type ConcreteCompletionCelebrationId = (typeof COMPLETION_CELEBRATIONS)[number]['id']
export type CompletionCelebrationId = 'random' | ConcreteCompletionCelebrationId

export const DEFAULT_COMPLETION_CELEBRATION_ID: CompletionCelebrationId = 'random'

export const COMPLETION_CELEBRATION_OPTIONS = [
  {
    id: 'random',
    name: 'Random',
    description: 'Pick a different celebration whenever a day is completed.',
    icon: '🎲', category: 'pretty', engine: 'particles', recipe: 'random', durationMs: 0, intensity: 1,
    palette: ['#71e5c6', '#7d8cff', '#e187ff'],
  },
  ...COMPLETION_CELEBRATIONS,
] as const satisfies readonly CompletionCelebrationDefinition[]

const COMPLETION_CELEBRATIONS_BY_ID = new Map<ConcreteCompletionCelebrationId, (typeof COMPLETION_CELEBRATIONS)[number]>(
  COMPLETION_CELEBRATIONS.map((celebration) => [celebration.id, celebration]),
)

export function normalizeCompletionCelebrationId(value: unknown): CompletionCelebrationId {
  return value === 'random' || (typeof value === 'string' && COMPLETION_CELEBRATIONS_BY_ID.has(value as ConcreteCompletionCelebrationId))
    ? value as CompletionCelebrationId
    : DEFAULT_COMPLETION_CELEBRATION_ID
}

export function getCompletionCelebration(id: CompletionCelebrationId) {
  if (id === 'random') {
    return COMPLETION_CELEBRATIONS[Math.floor(Math.random() * COMPLETION_CELEBRATIONS.length)]
  }
  return COMPLETION_CELEBRATIONS_BY_ID.get(id) ?? COMPLETION_CELEBRATIONS[0]
}
