// The "/" styles menu (contract P-31). Plain DOM, positioned below the block
// inside the editor host so it shares the Notes page zoom and scrolls with
// the document.

import type { NoteItemKind } from '../../types'

export type SlashCommand = {
  kind: NoteItemKind
  label: string
  hint: string
  aliases: string[]
  icon: string
}

const QUOTE_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 11H5V6h5v7a5 5 0 0 1-5 5M20 11h-5V6h5v7a5 5 0 0 1-5 5" /></svg>'

export const SLASH_COMMANDS: SlashCommand[] = [
  { kind: 'paragraph', label: 'Text', hint: 'Plain body text', aliases: [], icon: 'Aa' },
  { kind: 'heading', label: 'Heading', hint: 'Large section heading', aliases: ['h1', 'header'], icon: 'H' },
  { kind: 'quote', label: 'Quote', hint: 'Quote a passage', aliases: ['blockquote'], icon: QUOTE_ICON },
  { kind: 'bullet', label: 'Bulleted list', hint: 'Start a simple list', aliases: [], icon: '•' },
  { kind: 'numbered', label: 'Numbered list', hint: 'Start an ordered list', aliases: [], icon: '1.' },
  { kind: 'checklist', label: 'Checklist', hint: 'Track something to do', aliases: [], icon: '✓' },
]

export const SLASH_PATTERN = /^\/([^\s/]*)$/

export function filterSlashCommands(query: string): SlashCommand[] {
  const needle = query.toLowerCase()
  return SLASH_COMMANDS.filter((command) =>
    command.label.toLowerCase().includes(needle) || command.aliases.some((alias) => alias.includes(needle)))
}

export class SlashMenu {
  readonly element: HTMLDivElement
  private commands: SlashCommand[] = []
  private active = 0
  private anchor: HTMLElement | null = null
  blockKey: string | null = null

  constructor(private readonly host: HTMLElement, private readonly onApply: (command: SlashCommand) => void) {
    this.element = document.createElement('div')
    this.element.className = 'note-slash-menu lexical-slash-menu'
    this.element.setAttribute('role', 'listbox')
    this.element.setAttribute('aria-label', 'Note styles')
    this.element.hidden = true
    this.element.addEventListener('mousedown', (event) => {
      const option = (event.target as HTMLElement).closest<HTMLElement>('[role="option"]')
      event.preventDefault()
      if (!option) return
      const command = this.commands[Number(option.dataset.index)]
      if (command) this.onApply(command)
    })
    this.element.addEventListener('mousemove', (event) => {
      const option = (event.target as HTMLElement).closest<HTMLElement>('[role="option"]')
      if (option) this.setActive(Number(option.dataset.index))
    })
    host.append(this.element)
  }

  get isOpen(): boolean {
    return !this.element.hidden
  }

  open(anchor: HTMLElement, blockKey: string, query: string): boolean {
    const commands = filterSlashCommands(query)
    if (commands.length === 0) {
      this.close()
      return false
    }
    const changed = commands.length !== this.commands.length || commands.some((command, index) => command !== this.commands[index])
    const wasOpen = this.isOpen
    this.commands = commands
    this.anchor = anchor
    this.blockKey = blockKey
    if (changed || !wasOpen) {
      this.active = 0
      this.render()
    }
    this.element.hidden = false
    if (!wasOpen) {
      this.element.classList.remove('is-entering')
      void this.element.offsetWidth
      this.element.classList.add('is-entering')
    }
    this.position()
    return true
  }

  close() {
    if (this.element.hidden) return
    this.element.hidden = true
    this.element.classList.remove('is-entering')
    this.anchor = null
    this.blockKey = null
  }

  move(delta: number) {
    if (this.commands.length === 0) return
    this.setActive((this.active + delta + this.commands.length) % this.commands.length)
  }

  apply() {
    const command = this.commands[this.active]
    if (command) this.onApply(command)
  }

  destroy() {
    this.element.remove()
  }

  private setActive(index: number) {
    if (index === this.active || index < 0 || index >= this.commands.length) return
    this.active = index
    this.element.querySelectorAll<HTMLElement>('[role="option"]').forEach((option, optionIndex) => {
      const selected = optionIndex === index
      option.classList.toggle('active', selected)
      option.setAttribute('aria-selected', selected ? 'true' : 'false')
      if (selected) option.scrollIntoView({ block: 'nearest' })
    })
  }

  private render() {
    this.element.replaceChildren(...this.commands.map((command, index) => {
      const option = document.createElement('button')
      option.type = 'button'
      option.tabIndex = -1
      option.setAttribute('role', 'option')
      option.dataset.index = String(index)
      option.setAttribute('aria-selected', index === this.active ? 'true' : 'false')
      option.classList.toggle('active', index === this.active)
      const icon = document.createElement('span')
      icon.className = 'note-slash-icon'
      icon.setAttribute('aria-hidden', 'true')
      icon.innerHTML = command.icon
      const copy = document.createElement('span')
      copy.className = 'note-slash-copy'
      const label = document.createElement('strong')
      label.textContent = command.label
      const hint = document.createElement('small')
      hint.textContent = command.hint
      copy.append(label, hint)
      option.append(icon, copy)
      return option
    }))
  }

  // Below the block (4 px gap), clamped to the note document and the
  // viewport with 8 px margins; flips above when there is no room below.
  position() {
    if (!this.anchor || this.element.hidden) return
    const zoom = (this.host as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom || 1
    const hostRect = this.host.getBoundingClientRect()
    const blockRect = this.anchor.getBoundingClientRect()
    const documentRect = (this.host.closest('.note-document') ?? document.documentElement).getBoundingClientRect()
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight
    const viewportWidth = window.visualViewport?.width ?? window.innerWidth
    const bounds = {
      top: Math.max(8, documentRect.top + 8),
      bottom: Math.min(viewportHeight - 8, documentRect.bottom - 8),
      left: Math.max(8, documentRect.left + 8),
      right: Math.min(viewportWidth - 8, documentRect.right - 8),
    }
    // Measure at natural size first.
    this.element.style.left = '0px'
    this.element.style.top = '0px'
    this.element.style.maxHeight = ''
    const menuRect = this.element.getBoundingClientRect()
    const width = menuRect.width
    let height = menuRect.height
    const below = blockRect.bottom + 4 * zoom
    const above = blockRect.top - 4 * zoom
    let top: number
    if (below + height <= bounds.bottom || bounds.bottom - below >= above - bounds.top) {
      top = below
      if (top + height > bounds.bottom) height = Math.max(80, bounds.bottom - top)
    } else {
      height = Math.min(height, above - bounds.top)
      top = above - height
    }
    const textLeft = (this.anchor.querySelector('.note-text') ?? this.anchor).getBoundingClientRect().left
    let left = Math.min(textLeft, bounds.right - width)
    left = Math.max(bounds.left, left)
    this.element.style.maxHeight = `${height / zoom}px`
    this.element.style.left = `${(left - hostRect.left) / zoom}px`
    this.element.style.top = `${(top - hostRect.top) / zoom}px`
  }
}
