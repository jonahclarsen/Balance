// Shared driver for the Notes editor conformance suite. Every test seeds the
// browser build's localStorage state with the synthetic corpus, selects the
// editor under test through the same per-device preference the Settings
// switch writes, and reads results back from the persisted app state.

import { expect, test as base, type Locator, type Page } from '@playwright/test'
import { createNotesCorpus } from '../fixtures/notesCorpus'
import type { Note, NoteItem } from '../../src/lib/types'

export type EditorName = 'tiptap' | 'lexical'

export const test = base.extend<{ noteEditor: EditorName; harness: Harness }>({
  noteEditor: ['tiptap', { option: true }],
  harness: async ({ page, noteEditor }, use) => {
    await use(new Harness(page, noteEditor))
  },
})

export { expect }

const STATE_KEY = 'balance.appState.v1'
const EDITOR_KEY = 'balance:noteEditor.v1'

export const isMac = process.platform === 'darwin'
export const mod = isMac ? 'Meta' : 'Control'

export class Harness {
  readonly corpus: Note[]

  constructor(readonly page: Page, readonly editor: EditorName) {
    this.corpus = createNotesCorpus()
  }

  noteByTitle(title: string): Note {
    const note = this.corpus.find((candidate) => candidate.title === title)
    if (!note) throw new Error(`No corpus note titled ${title}`)
    return note
  }

  // Boot the app with the corpus installed and the editor selected. Opens the
  // Notes view; the first corpus note is selected by default (most recent).
  async boot(options: { notes?: Note[]; select?: string; platform?: 'mac' | 'other' } = {}) {
    const notes = options.notes ?? this.corpus
    const platform = options.platform ?? (isMac ? 'mac' : 'other')
    await this.page.addInitScript((value) => {
      Object.defineProperty(navigator, 'platform', { get: () => value })
    }, platform === 'mac' ? 'MacIntel' : 'Win32')
    await this.page.goto('/')
    await this.page.evaluate(() => localStorage.clear())
    await this.page.reload()
    // The app has now written a well-formed initial state; splice the notes in.
    await this.page.evaluate(([key, editorKey, editor, seeded]) => {
      const state = JSON.parse(localStorage.getItem(key) || '{}')
      state.notes = seeded
      localStorage.setItem(key, JSON.stringify(state))
      localStorage.setItem(editorKey, editor)
    }, [STATE_KEY, EDITOR_KEY, this.editor, notes] as const)
    await this.page.reload()
    await this.openNotesView()
    if (options.select) await this.selectNote(options.select)
    // An empty note hides the editor behind "Start writing…" (P-16).
    await expect(this.editorRoot()).toBeAttached()
  }

  async openNotesView() {
    const mobileMenu = this.page.locator('.mobile-app-header').getByRole('button', { name: 'Open navigation' })
    if (await mobileMenu.isVisible()) {
      await mobileMenu.click()
      await this.page.getByRole('complementary', { name: 'Primary navigation drawer' })
        .getByRole('button', { name: 'Notes', exact: true })
        .click()
      return
    }
    await this.page.getByRole('button', { name: 'Notes', exact: true }).click()
  }

  async selectNote(title: string) {
    const card = this.page.locator('.note-card').filter({
      has: this.page.locator('strong', { hasText: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }),
    }).first()
    await card.scrollIntoViewIfNeeded()
    await card.click()
    await expect(this.page.locator('#note-title')).toHaveValue(title === 'Untitled note' ? '' : title)
  }

  // The editor's contenteditable root. Both editors must mark it with
  // data-rich-text-input so the app's global shortcuts treat it as text input.
  editorRoot(): Locator {
    return this.page.locator(`[data-note-editor="${this.editor}"] [data-rich-text-input]`).first()
  }

  // A block element by item id. Both editors must expose data-item-id on the
  // element that represents each block.
  block(itemId: string): Locator {
    return this.page.locator(`[data-note-editor="${this.editor}"] [data-item-id="${itemId}"]`).first()
  }

  blocks(): Locator {
    return this.page.locator(`[data-note-editor="${this.editor}"] [data-item-id]`)
  }

  async storedNotes(): Promise<Note[]> {
    return this.page.evaluate((key) => JSON.parse(localStorage.getItem(key) || '{}').notes ?? [], STATE_KEY)
  }

  async storedNote(noteId: string): Promise<Note | undefined> {
    return (await this.storedNotes()).find((note) => note.id === noteId)
  }

  // Waits for the store's debounced persistence to catch up with the given
  // predicate on the note.
  async waitForNote(noteId: string, predicate: (note: Note) => boolean, message?: string) {
    await expect.poll(async () => {
      const note = await this.storedNote(noteId)
      return note ? predicate(note) : false
    }, { message, timeout: 5_000 }).toBe(true)
  }

  // Place the caret at a text offset inside a block and focus it.
  async placeCaret(itemId: string, offset: number, end = offset) {
    await this.block(itemId).evaluate((element, [start, finish]) => {
      const editable = element.closest<HTMLElement>('[data-rich-text-input]') ?? element
      editable.focus()
      const textNodes: Text[] = []
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) textNodes.push(node as Text)
      const point = (target: number) => {
        let remaining = target
        for (const node of textNodes) {
          if (remaining <= node.length) return { node, offset: remaining }
          remaining -= node.length
        }
        const last = textNodes.at(-1)
        return last ? { node: last, offset: last.length } : { node: element, offset: 0 }
      }
      const a = point(start)
      const b = point(finish)
      document.getSelection()?.setBaseAndExtent(a.node, a.offset, b.node, b.offset)
      element.dispatchEvent(new Event('selectionchange', { bubbles: true }))
    }, [offset, end] as const)
  }

  async caretItemId(): Promise<string | null> {
    return this.page.evaluate(() => {
      const selection = document.getSelection()
      const node = selection?.anchorNode
      const element = node instanceof Element ? node : node?.parentElement
      return element?.closest<HTMLElement>('[data-item-id]')?.dataset.itemId ?? null
    })
  }

  async caretOffset(): Promise<number | null> {
    return this.page.evaluate(() => {
      const selection = document.getSelection()
      const node = selection?.anchorNode
      if (!node) return null
      const element = node instanceof Element ? node : node.parentElement
      const block = element?.closest<HTMLElement>('[data-item-id]')
      if (!block) return null
      const range = document.createRange()
      range.selectNodeContents(block)
      range.setEnd(node, selection!.anchorOffset)
      return range.toString().length
    })
  }

  // Simulate the store receiving a change from another device: mutate the
  // persisted state and dispatch a storage event... the browser build does not
  // listen to storage events, so instead call into the exposed store hook the
  // app installs for tests (window.__balanceApplyRemoteNoteItems).
  async applyRemoteItems(noteId: string, mutate: (items: NoteItem[]) => NoteItem[]) {
    await this.page.evaluate(([id, source]) => {
      const hook = (window as unknown as { __balanceNotesTestHook?: { replaceItems: (noteId: string, fn: string) => void } }).__balanceNotesTestHook
      if (!hook) throw new Error('notes test hook missing')
      hook.replaceItems(id, source)
    }, [noteId, mutate.toString()] as const)
  }

  async undo() {
    await this.page.keyboard.press(`${mod}+z`)
  }

  async redo() {
    await this.page.keyboard.press(`Shift+${mod}+z`)
  }
}

export function flatten(items: NoteItem[]): NoteItem[] {
  return items.flatMap((item) => [item, ...flatten(item.children)])
}

export function ids(items: NoteItem[]): string[] {
  return flatten(items).map((item) => item.id)
}

// Strips fields the editors are allowed to touch only through explicit edits,
// so equality compares exactly what a lossless round trip must preserve.
export function comparable(items: NoteItem[]): unknown {
  return items.map((item) => ({ ...item, children: comparable(item.children) }))
}
