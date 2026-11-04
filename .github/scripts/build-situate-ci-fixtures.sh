#!/usr/bin/env bash
set -euo pipefail
[[ "${CI:-}" == true ]] || { echo 'CI Android toolchain only'; exit 1; }
sdk=${ANDROID_HOME:?}
tools="$sdk/build-tools/34.0.0"
fixture_dir=$(mktemp -d)
trap 'rm -rf "$fixture_dir"' EXIT
mkdir -p "$fixture_dir/classes" "$fixture_dir/dex"
javac -source 8 -target 8 -cp "$sdk/platforms/android-34/android.jar" -d "$fixture_dir/classes" .github/scripts/fixtures/situate/FixtureActivity.java
mapfile -t classes < <(find "$fixture_dir/classes" -name '*.class')
"$tools/d8" --lib "$sdk/platforms/android-34/android.jar" --output "$fixture_dir/dex" "${classes[@]}"
keytool -genkeypair -keystore "$fixture_dir/fixture.jks" -storepass android -keypass android -alias fixture -dname 'CN=Synthetic Situate CI' -keyalg RSA -validity 3
for kind in allowed blocked; do
  cat > "$fixture_dir/AndroidManifest.xml" <<XML
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="app.balance.fixture.$kind">
 <application android:theme="@android:style/Theme.Material.Light.NoActionBar" android:label="Situate fixture" android:allowBackup="false">
  <activity android:name="app.balance.fixture.FixtureActivity" android:exported="true" android:resizeableActivity="true" />
 </application>
</manifest>
XML
  "$tools/aapt2" link -I "$sdk/platforms/android-34/android.jar" --manifest "$fixture_dir/AndroidManifest.xml" --min-sdk-version 26 --target-sdk-version 34 -o "$fixture_dir/unsigned.apk"
  (cd "$fixture_dir/dex" && zip -q -j "$fixture_dir/unsigned.apk" classes.dex)
  "$tools/apksigner" sign --ks "$fixture_dir/fixture.jks" --ks-pass pass:android --out "situate-$kind.apk" "$fixture_dir/unsigned.apk"
done
