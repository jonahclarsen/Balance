import { readFile, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import process from 'node:process'

if (process.platform !== 'darwin' || process.env.BALANCE_SKIP_MACOS_WIDGET === '1') {
  process.exit(0)
}

const root = resolve(import.meta.dirname, '..')
const outputRoot = resolve(root, 'src-tauri/target/macos-widget')
const xcodeBuildRoot = resolve(root, 'src-tauri/target/macos-widget-xcode')
const extensionRoot = resolve(outputRoot, 'BalanceWidget.appex')
const project = resolve(root, 'src-tauri/macos/BalanceWidget.xcodeproj')
const config = JSON.parse(await readFile(resolve(root, 'src-tauri/tauri.conf.json'), 'utf8'))
const version = process.env.APP_VERSION || config.version

await rm(outputRoot, { recursive: true, force: true })
await rm(xcodeBuildRoot, { recursive: true, force: true })
execFileSync('xcodebuild', [
  '-quiet',
  '-project', project,
  '-target', 'BalanceWidget',
  '-configuration', 'Release',
  '-sdk', 'macosx',
  'ARCHS=arm64 x86_64',
  'ONLY_ACTIVE_ARCH=NO',
  `CONFIGURATION_BUILD_DIR=${outputRoot}`,
  `OBJROOT=${xcodeBuildRoot}`,
  `SYMROOT=${xcodeBuildRoot}`,
  `CURRENT_PROJECT_VERSION=${version}`,
  `MARKETING_VERSION=${version}`,
  'CODE_SIGNING_ALLOWED=NO',
  'build',
], { stdio: 'inherit' })

const signingIdentity = process.env.APPLE_SIGNING_IDENTITY || '-'
execFileSync('codesign', [
  '--force',
  '--sign',
  signingIdentity,
  '--options',
  'runtime',
  '--entitlements',
  resolve(root, 'src-tauri/macos/BalanceWidget/BalanceWidget.entitlements'),
  extensionRoot,
], { stdio: 'inherit' })

console.log(`Built universal macOS widget ${extensionRoot}`)
