import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execute = promisify(execFile);
const script = new URL("./configure-android-signing.mjs", import.meta.url);

const fixture = `android {
    buildTypes {
        getByName("release") {
            isMinifyEnabled = true
        }
    }
}
`;

async function configure(minify) {
  const directory = await mkdtemp(join(tmpdir(), "balance-android-signing-"));
  const gradlePath = join(directory, "build.gradle.kts");
  await writeFile(gradlePath, fixture);
  await execute(process.execPath, [script.pathname, gradlePath], {
    env: {
      ...process.env,
      ANDROID_KEYSTORE_PATH: "/tmp/test-only-keystore.jks",
      ANDROID_KEYSTORE_PASSWORD: "test-only-password",
      ANDROID_KEY_ALIAS: "test-only-alias",
      BALANCE_ANDROID_MINIFY_RELEASE: minify,
    },
  });
  return readFile(gradlePath, "utf8");
}

test("keeps R8 enabled for production release builds", async () => {
  const gradle = await configure("true");
  assert.match(gradle, /signingConfig = signingConfigs\.getByName\("release"\)/);
  assert.match(gradle, /isMinifyEnabled = true/);
});

test("disables R8 for manually requested development releases", async () => {
  const gradle = await configure("false");
  assert.match(gradle, /signingConfig = signingConfigs\.getByName\("release"\)/);
  assert.match(gradle, /isMinifyEnabled = false/);
});
