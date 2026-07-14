import { readFile, writeFile } from "node:fs/promises";

const gradlePath =
  process.argv[2] ?? "src-tauri/gen/android/app/build.gradle.kts";

const requiredEnvironmentVariables = [
  "ANDROID_KEYSTORE_PATH",
  "ANDROID_KEYSTORE_PASSWORD",
  "ANDROID_KEY_ALIAS",
];

for (const name of requiredEnvironmentVariables) {
  if (!process.env[name]) {
    throw new Error(`Missing required Android signing variable: ${name}`);
  }
}

let gradle = await readFile(gradlePath, "utf8");

const buildTypesMarker = "    buildTypes {";
const releaseMarker = `        getByName("release") {
            isMinifyEnabled = true`;

if (!gradle.includes(buildTypesMarker) || !gradle.includes(releaseMarker)) {
  throw new Error(
    `Could not find the expected Tauri Android build blocks in ${gradlePath}`,
  );
}

gradle = gradle.replace(
  buildTypesMarker,
  `    signingConfigs {
        create("release") {
            storeFile = file(requireNotNull(System.getenv("ANDROID_KEYSTORE_PATH")))
            storePassword = requireNotNull(System.getenv("ANDROID_KEYSTORE_PASSWORD"))
            keyAlias = requireNotNull(System.getenv("ANDROID_KEY_ALIAS"))
            keyPassword = requireNotNull(System.getenv("ANDROID_KEYSTORE_PASSWORD"))
        }
    }
    buildTypes {`,
);

gradle = gradle.replace(
  releaseMarker,
  `        getByName("release") {
            signingConfig = signingConfigs.getByName("release")
            isMinifyEnabled = true`,
);

await writeFile(gradlePath, gradle);
console.log(`Configured release signing in ${gradlePath}`);
