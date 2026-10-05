import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const script = new URL('./profile-native-theme.sh', import.meta.url).pathname
const profile = { samples: 30, dayTheme: { persistOperation: { p95Ms: 80 } } }

for (const [name, cargoStatus, emitProfile, expectedStatus, extractionFails = false] of [
  ['successful profile', 0, true, 0],
  ['failed performance gate retains JSON and cargo status', 101, true, 101],
  ['compile failure retains log and cargo status', 101, false, 101],
  ['successful cargo without a profile fails extraction', 0, false, 1],
  ['cargo failure survives an extraction error', 101, true, 101, true],
  ['extraction error fails an otherwise successful profile', 0, true, 17, true],
]) {
  test(name, () => {
    const directory = mkdtempSync(join(tmpdir(), 'balance-theme-wrapper-'))
    try {
      const bin = join(directory, 'bin')
      const results = join(directory, 'results')
      mkdirSync(bin)
      if (extractionFails) {
        writeFileSync(join(bin, 'sed'), '#!/usr/bin/env bash\nexit 17\n', { mode: 0o755 })
      }
      // A synthetic cargo process tests the actual shell wrapper independently
      // of the Rust toolchain. Real encrypted fixtures also run in macOS CI.
      writeFileSync(join(bin, 'cargo'), `#!/usr/bin/env node
process.stderr.write('synthetic cargo log\\n')
if (${emitProfile}) process.stderr.write('THEME_NATIVE_PERF ${JSON.stringify(profile)}\\n')
process.exit(${cargoStatus})
`, { mode: 0o755 })
      const result = spawnSync('bash', [script, results], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        encoding: 'utf8',
      })
      assert.equal(result.status, expectedStatus, result.stderr)
      assert.match(readFileSync(join(results, 'theme-native-performance.log'), 'utf8'), /synthetic cargo log/)
      const raw = readFileSync(join(results, 'theme-native-performance.json'), 'utf8')
      const extracted = emitProfile && !extractionFails
      assert.deepEqual(extracted ? JSON.parse(raw) : raw, extracted ? profile : '')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
}
