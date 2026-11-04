// Cmd/Ctrl+Shift already means something else with these: select all, redo,
// generate selected day, recovery panel, macOS log out, redo.
const RESERVED_LETTERS = 'ACGPQZ'

// Gives each day template the first letter of its name that is neither reserved
// nor taken by an earlier template, for its Cmd/Ctrl+Shift generate shortcut.
export function dayTemplateShortcutLetters(names: string[]): (string | null)[] {
  const taken = new Set<string>(RESERVED_LETTERS)
  return names.map((name) => {
    const letter = [...name.toUpperCase()].find((char) => char >= 'A' && char <= 'Z' && !taken.has(char)) ?? null
    if (letter) taken.add(letter)
    return letter
  })
}
