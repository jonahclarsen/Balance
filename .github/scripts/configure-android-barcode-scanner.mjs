import { readdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const lockfile = await readFile('src-tauri/Cargo.lock', 'utf8')
const packageBlock = lockfile
  .split('[[package]]')
  .find((block) => /\nname = "tauri-plugin-barcode-scanner"\n/.test(`\n${block}`))
const version = packageBlock?.match(/\nversion = "([^"]+)"/)?.[1]

if (!version) {
  throw new Error('Could not determine tauri-plugin-barcode-scanner version from Cargo.lock')
}

const registrySources = join(process.env.CARGO_HOME || join(homedir(), '.cargo'), 'registry', 'src')
const registries = await readdir(registrySources, { withFileTypes: true })
const candidates = registries
  .filter((entry) => entry.isDirectory())
  .map((entry) =>
    join(
      registrySources,
      entry.name,
      `tauri-plugin-barcode-scanner-${version}`,
      'android',
      'build.gradle.kts',
    ),
  )

let pluginGradle
for (const candidate of candidates) {
  try {
    await readFile(candidate)
    pluginGradle = candidate
    break
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

if (!pluginGradle) {
  throw new Error(`Could not find the Android Gradle file for tauri-plugin-barcode-scanner ${version}`)
}

const gradle = await readFile(pluginGradle, 'utf8')
const unbundledDependency = /implementation\("com\.google\.android\.gms:play-services-mlkit-barcode-scanning:[^"]+"\)/
const bundledDependency = 'implementation("com.google.mlkit:barcode-scanning:17.3.0")'

if (!unbundledDependency.test(gradle) && !gradle.includes(bundledDependency)) {
  throw new Error('The barcode scanner Gradle dependency was not in the expected form')
}

await writeFile(pluginGradle, gradle.replace(unbundledDependency, bundledDependency))
console.log(`Bundled the offline ML Kit barcode model in ${pluginGradle}`)
