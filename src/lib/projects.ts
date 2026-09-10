import { todayISO } from './planner'
import type { ProjectCheckIn } from './types'

export function projectCheckInForDay(entries: ProjectCheckIn[], projectId: string, day: string): ProjectCheckIn | undefined {
  let latest: ProjectCheckIn | undefined
  for (const entry of entries) {
    if (entry.projectId !== projectId || todayISO(new Date(entry.createdAt)) !== day) continue
    if (!latest || entry.createdAt > latest.createdAt || (entry.createdAt === latest.createdAt && entry.id > latest.id)) latest = entry
  }
  return latest
}
