// Kotlin methods that Rust calls by name through JNI. R8 cannot see those
// references, so each must be @Keep or a minified release renames it and every
// call fails with "Java exception was thrown".
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export const ENTRY_POINTS = {
  'app.balance.local.BalanceSituate': ['call'],
  'app.balance.local.BalanceTaskNotifications': ['replace'],
  'app.balance.local.BalanceUpdater': ['install'],
  'app.balance.local.BalanceFreezeDiagnostics': ['save'],
}

/** Method names per class descriptor (`Lapp/balance/local/X;`) in one dex file. */
export function dexMethods(dex) {
  const u32 = offset => dex.readUInt32LE(offset)
  const uleb = offset => {
    let result = 0, shift = 0, byte
    do { byte = dex[offset++]; result |= (byte & 0x7f) << shift; shift += 7 } while (byte & 0x80)
    return offset
  }
  const stringAt = index => {
    const start = uleb(u32(u32(60) + 4 * index))
    return dex.toString('utf8', start, dex.indexOf(0, start))
  }
  const typeAt = index => stringAt(u32(u32(68) + 4 * index))
  const methods = new Map()
  for (let i = 0, offset = u32(92); i < u32(88); i++, offset += 8) {
    const owner = typeAt(dex.readUInt16LE(offset))
    if (!methods.has(owner)) methods.set(owner, new Set())
    methods.get(owner).add(stringAt(u32(offset + 4)))
  }
  return methods
}

/** Entry points missing from an APK, as `Class.method`. */
export function missingFromApk(apk) {
  const found = new Map()
  const entries = execFileSync('unzip', ['-Z1', apk], { encoding: 'utf8' }).split('\n')
  for (const entry of entries.filter(name => /^classes\d*\.dex$/.test(name))) {
    const dex = execFileSync('unzip', ['-p', apk, entry], { maxBuffer: 1 << 30 })
    for (const [owner, names] of dexMethods(dex)) found.set(owner, new Set([...(found.get(owner) ?? []), ...names]))
  }
  return Object.entries(ENTRY_POINTS).flatMap(([owner, names]) =>
    names.filter(name => !found.get(`L${owner.replaceAll('.', '/')};`)?.has(name)).map(name => `${owner}.${name}`))
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const missing = missingFromApk(process.argv[2])
  if (missing.length) {
    console.error(`::error::R8 removed or renamed JNI entry points: ${missing.join(', ')}`)
    process.exit(1)
  }
  console.log('Every Rust-called JNI entry point survived R8.')
}
