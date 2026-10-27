import { copyFile, mkdir } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import process from 'node:process'

// balance-transcriber runs Parakeet for voice ideas. Tauri bundles it next to
// the app executable (see tauri.macos.conf.json); `tauri dev` finds it here.
if (process.platform !== 'darwin' || process.env.BALANCE_SKIP_MACOS_TRANSCRIBER === '1') {
  process.exit(0)
}

const root = resolve(import.meta.dirname, '..')
const packagePath = resolve(root, 'src-tauri/macos/BalanceTranscriber')
const output = resolve(root, 'src-tauri/target/macos-transcriber/balance-transcriber')

execFileSync('swift', ['build', '-c', 'release', '--package-path', packagePath], { stdio: 'inherit' })
const binPath = execFileSync('swift', ['build', '-c', 'release', '--package-path', packagePath, '--show-bin-path'], { encoding: 'utf8' }).trim()
await mkdir(resolve(output, '..'), { recursive: true })
await copyFile(resolve(binPath, 'BalanceTranscriber'), output)

const signingIdentity = process.env.APPLE_SIGNING_IDENTITY || '-'
// Notarization requires a secure timestamp, which ad-hoc signatures cannot carry.
const timestamp = signingIdentity === '-' ? [] : ['--timestamp']
execFileSync('codesign', ['--force', '--sign', signingIdentity, ...timestamp, '--options', 'runtime', output], { stdio: 'inherit' })

console.log(`Built ${output}`)
