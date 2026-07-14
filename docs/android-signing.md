# Android release signing

Android uses an app's signing certificate as part of its permanent identity.
Every update installed outside Google Play must be signed by the same key as the
installed version. For Google Play releases, this repository's key is normally
the upload key; Play App Signing keeps a separate app-signing key and signs the
APKs delivered to users.

The Android workflow produces two kinds of artifact:

- `Balance-android-debug` is signed with CI's disposable debug key and is only
  used by the emulator smoke test.
- `Balance-android-release` contains a signed APK for direct installation, a
  signed AAB for Google Play, and the signing certificate fingerprint reported
  by `apksigner`.

For tag builds, the release version and Android version code come from the
`v<major>.<minor>.<patch>` tag. A manual workflow run uses the version in
`src-tauri/tauri.conf.json`.

The release build reads these GitHub Actions repository secrets:

- `ANDROID_KEYSTORE_BASE64`: the upload keystore encoded with base64
- `ANDROID_KEYSTORE_PASSWORD`: the keystore and key password
- `ANDROID_KEY_ALIAS`: the key alias (currently `upload`)

The private keystore and its password must never be committed. Keep an offline
backup of the keystore. Losing a self-managed app-signing key makes direct APK
updates impossible; a lost Play upload key can instead be reset through Play
Console when Play App Signing is enabled.

The current upload keystore is stored on the maintainer's Mac at
`~/Library/Application Support/Balance/signing/upload-keystore.jks`. Its password
is in macOS Keychain under the service `Balance Android upload keystore` and
account `upload`. The upload certificate's SHA-256 fingerprint is
`65:16:C6:98:97:1A:83:FF:ED:D0:B3:95:4A:5C:13:C5:88:C2:BC:7A:A7:3D:A3:3D:E1:87:48:A0:F7:54:02:B5`.

Before the first store upload, confirm the Tauri `identifier` in
`src-tauri/tauri.conf.json`. The current Android application ID is
`app.balance.local`, and changing it after publishing creates a different app.
