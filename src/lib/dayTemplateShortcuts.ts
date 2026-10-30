// Gives each day template the first letter of its name that an earlier
// template hasn't taken, for its Alt+Shift generate shortcut.
export function dayTemplateShortcutLetters(names: string[]): (string | null)[] {
  const taken = new Set<string>()
  return names.map((name) => {
    const letter = [...name.toUpperCase()].find((char) => char >= 'A' && char <= 'Z' && !taken.has(char)) ?? null
    if (letter) taken.add(letter)
    return letter
  })
}
