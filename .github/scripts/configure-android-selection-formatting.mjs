import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const activityPath = process.argv[2] ?? 'src-tauri/gen/android/app/src/main/java/app/balance/local/MainActivity.kt'
const marker = '// Balance Android selection formatting'
let activity = await readFile(activityPath, 'utf8')
if (!activity.includes(marker)) {
  const end = activity.lastIndexOf('}')
  if (end < 0 || !/class MainActivity\s*:\s*TauriActivity\(\)\s*\{/.test(activity)) {
    throw new Error(`Expected initialized MainActivity body in ${activityPath}`)
  }
  activity = activity.slice(0, end) + `
    ${marker}
    // Wrap the WebView so its floating menu callback is extended on the way to
    // the window. Restarting the action mode from the window callback instead
    // makes DecorView finish the nested mode as soon as it is shown.
    override fun setContentView(view: android.view.View?) {
        val webView = view as? android.webkit.WebView
        if (webView == null) super.setContentView(view)
        else super.setContentView(BalanceSelectionFormattingHost(this, webView))
    }
` + activity.slice(end)
  await writeFile(activityPath, activity)
}
const script = await readFile(new URL('../android/selection-formatting.js', import.meta.url), 'utf8')
const template = await readFile(new URL('../android/BalanceSelectionFormatting.kt', import.meta.url), 'utf8')
// JSON string escaping is also valid for this Kotlin string once $ is escaped.
const source = template.replace('__SELECTION_SCRIPT__', () => JSON.stringify(script).replaceAll('$', '\\$'))
await writeFile(join(dirname(activityPath), 'BalanceSelectionFormatting.kt'), source)
