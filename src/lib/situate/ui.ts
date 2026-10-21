import { CATEGORIES, type Category, type Platform, type Target } from './core'
export const DEVICES: { id: Platform; label: string }[] = [{ id: 'mac', label: 'Desktop' }, { id: 'android', label: 'Mobile' }]
export const KINDS: { id: Target['kind']; label: string }[] = [{ id: 'domain', label: 'Website' }, { id: 'app', label: 'App' }, { id: 'discord', label: 'Discord' }]
export const categoryOf = (id: Category) => CATEGORIES.find(c => c.id === id) ?? CATEGORIES[CATEGORIES.length - 1]
export const clockTime = (at: number) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
/** Bundle and package IDs read like reversed domains; Discord IDs are numeric. */
export function guessKind(value: string): Target['kind'] {
  if (/^\d{15,22}$/.test(value)) return 'discord'
  return /^(com|org|net|io|app|xyz|dev|me|co|tv|us|uk|de|fr|ca|ai|so)\.[^.]+/i.test(value) && !/\.(com|org|net|io|app|dev|tv|ai)$/i.test(value) ? 'app' : 'domain'
}
