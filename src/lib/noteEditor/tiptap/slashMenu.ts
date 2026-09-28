// The "/" styles menu (contract P-31). A listbox positioned under the block
// that holds the caret, clamped inside the note document and the viewport.

import type { NoteItemKind } from '../../types'

export type SlashCommand = { kind: NoteItemKind; label: string; hint: string; aliases: string[]; icon: string }

const QUOTE_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 11H5V6h5v7a5 5 0 0 1-5 5M20 11h-5V6h5v7a5 5 0 0 1-5 5" /></svg>'

export const SLASH_COMMANDS: SlashCommand[] = [
  { kind: 'paragraph', label: 'Text', hint: 'Plain body text', aliases: ['paragraph'], icon: 'Aa' },
  { kind: 'heading', label: 'Heading', hint: 'Large section heading', aliases: ['h1', 'header'], icon: 'H' },
  { kind: 'quote', label: 'Quote', hint: 'Quote a passage', aliases: ['blockquote'], icon: QUOTE_ICON },
  { kind: 'bullet', label: 'Bulleted list', hint: 'Start a simple list', aliases: [], icon: '•' },
  { kind: 'numbered', label: 'Numbered list', hint: 'Start an ordered list', aliases: [], icon: '1.' },
  { kind: 'checklist', label: 'Checklist', hint: 'Track something to do', aliases: [], icon: '✓' },
]

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
  private readonly reposition = () => this.place()

  constructor(private readonly container: HTMLElement, private readonly onApply: (command: SlashCommand) => void) {
    this.element = document.createElement('div')
    this.element.className = 'note-slash-menu tt-slash-menu'
    this.element.setAttribute('role', 'listbox')
    this.element.setAttribute('aria-label', 'Note styles')
    this.element.hidden = true
    container.append(this.element)
  }

  get isOpen(): boolean {
    return !this.element.hidden
  }

  show(commands: SlashCommand[], anchor: HTMLElement) {
    const changed = commands.length !== this.commands.length || commands.some((command, index) => command !== this.commands[index])
    if (changed) {
      this.commands = commands
      this.active = 0
      this.render()
    }
    this.anchor = anchor
    if (!this.isOpen) {
      this.element.hidden = false
      window.addEventListener('resize', this.reposition)
      window.addEventListener('scroll', this.reposition, true)
    }
    this.place()
  }

  hide() {
    if (!this.isOpen) return
    this.element.hidden = true
    this.anchor = null
    window.removeEventListener('resize', this.reposition)
    window.removeEventListener('scroll', this.reposition, true)
  }

  move(delta: number) {
    if (this.commands.length === 0) return
    this.active = (this.active + delta + this.commands.length) % this.commands.length
    this.render()
  }

  applyActive() {
    const command = this.commands[this.active]
    if (command) this.onApply(command)
  }

  destroy() {
    this.hide()
    this.element.remove()
  }

  private render() {
    this.element.replaceChildren()
    this.commands.forEach((command, index) => {
      const option = document.createElement('button')
      option.type = 'button'
      option.tabIndex = -1
      option.setAttribute('role', 'option')
      option.setAttribute('aria-selected', index === this.active ? 'true' : 'false')
      option.className = index === this.active ? 'active' : ''
      option.innerHTML = `<span class="note-slash-icon" aria-hidden="true">${command.icon}</span><span class="tt-slash-text"><strong></strong><small></small></span>`
      option.querySelector('strong')!.textContent = command.label
      option.querySelector('small')!.textContent = command.hint
      option.addEventListener('mousedown', (event) => {
        event.preventDefault()
        this.onApply(command)
      })
      option.addEventListener('mousemove', () => {
        if (this.active === index) return
        this.active = index
        this.render()
      })
      this.element.append(option)
    })
    this.element.querySelector('.active')?.scrollIntoView({ block: 'nearest' })
  }

  // Coordinates are computed in the container's (zoomed) CSS pixel space.
  private place() {
    const anchor = this.anchor
    if (!anchor || !anchor.isConnected) return
    const menu = this.element
    const containerRect = this.container.getBoundingClientRect()
    const scale = this.container.offsetWidth > 0 ? containerRect.width / this.container.offsetWidth : 1
    const anchorRect = anchor.getBoundingClientRect()
    const documentRect = this.container.closest('.note-document')?.getBoundingClientRect()
    const gap = 8
    const viewTop = Math.max(0, documentRect?.top ?? 0) + gap
    const viewBottom = Math.min(window.innerHeight, documentRect && documentRect.bottom > 0 ? documentRect.bottom : window.innerHeight) - gap
    const viewLeft = Math.max(0, documentRect?.left ?? 0) + gap
    const viewRight = Math.min(window.innerWidth, documentRect?.right ?? window.innerWidth) - gap

    menu.style.maxWidth = `${Math.max(160, (viewRight - viewLeft) / scale)}px`
    menu.style.maxHeight = `${Math.max(120, Math.min(320, (window.innerHeight - 16) / scale))}px`
    const width = menu.offsetWidth * scale
    const height = menu.offsetHeight * scale

    let top = anchorRect.bottom + 4 * scale
    if (top + height > viewBottom && anchorRect.top - 4 * scale - height >= viewTop) top = anchorRect.top - 4 * scale - height
    top = Math.max(viewTop, Math.min(top, viewBottom - height))
    let left = anchorRect.left
    left = Math.max(viewLeft, Math.min(left, viewRight - width))
    menu.style.top = `${(top - containerRect.top) / scale}px`
    menu.style.left = `${(left - containerRect.left) / scale}px`
  }
}
