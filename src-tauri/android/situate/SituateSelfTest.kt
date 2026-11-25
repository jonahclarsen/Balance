package app.balance.local

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** Runs only on an explicitly marked debug CI installation, with separate fixture keys. */
object SituateSelfTest {
    fun runIfRequested(context: Context) {
        val marker=File(context.filesDir,"situate-ci-selftest")
        if ((context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE)==0 || !marker.delete()) return
        val directory=File(context.cacheDir,"situate-fixture-"+java.util.UUID.randomUUID()).apply { mkdirs() }
        val namespace="balance.situate.test."+java.util.UUID.randomUUID()
        try {
            // Permission reporting must work on a fresh disposable install, before setup.
            val permissions = JSONObject(BalanceSituate.call(context, "permissions", "status"))
            for (name in listOf("notifications", "accessibility", "usage", "mode-notifications", "alarms", "battery", "samsung")) {
                check(permissions.get(name) is Boolean) { "Missing permission status: $name" }
            }
            check(permissions.getBoolean("usage") == SituateAppIdentity.permitted(context))
            for (text in listOf("Your code is 4821", "G-12345678", "Enter 482913 to sign in", "Your Verification Code is below")) check(SituateCodes.extract(text) != null) { "Code not detected" }
            for (text in listOf("See you at 5", "Call 123", "Order 123456789", "No code here", "+1 416-555-1234", "(416) 555 1234", "416.555.1234", "Sent you $2500", "Up 1500%")) check(SituateCodes.extract(text) == null) { "False code match" }
            for (text in listOf("Back in 2024", "Plans for 2026", "By 2032")) check(SituateCodes.extract(text, 2026) == null) { "Year read as a code" }
            for (text in listOf("Code 2023", "Code 2033", "Code 12026", "Code 0202")) check(SituateCodes.extract(text, 2026) != null) { "Code read as a year" }
            // Real Android notification shapes: stale conversation codes must not
            // exempt later ordinary messages copied into expanded text/lines.
            fun message(text: String) = android.os.Bundle().apply { putCharSequence("text", text) }
            fun conversation(vararg texts: String) = android.app.Notification.Builder(context, "situate")
                .setSmallIcon(android.R.drawable.ic_lock_idle_lock).setContentTitle("Synthetic sender")
                .setContentText(texts.last()).setStyle(android.app.Notification.BigTextStyle().bigText(texts.joinToString("\n")))
                .addExtras(android.os.Bundle().apply { putParcelableArray(android.app.Notification.EXTRA_MESSAGES, texts.map { message(it) }.toTypedArray()) }).build()
            check(SituateCodes.extract(conversation("Your code is 482913", "See you soon")) == null) { "Historical code bypassed blocking" }
            check(SituateCodes.extract(conversation("See you soon", "Your code is 482913")) == "482913") { "Newest code was blocked" }
            val inbox = android.app.Notification.Builder(context, "situate").setSmallIcon(android.R.drawable.ic_lock_idle_lock)
                .setStyle(android.app.Notification.InboxStyle().addLine("Your code is 482913").addLine("See you soon")).build()
            check(SituateCodes.extract(inbox) == null) { "Historical inbox code bypassed blocking" }
            check(SituateCodes.extract("Your code is 004821") == "004821") { "Code formatting changed" }
            check(SituateCodes.extract("Ordinary message 482913 with private words") == "482913") { "Numeric rule changed" }
            fun plain(text: String) = android.app.Notification.Builder(context, "situate")
                .setSmallIcon(android.R.drawable.ic_lock_idle_lock).setContentTitle("Synthetic app").setContentText(text).build()
            val placeholder = android.content.res.Resources.getSystem().let { r ->
                @Suppress("DiscouragedApi") val id = r.getIdentifier("redacted_notification_message", "string", "android")
                if (id != 0) r.getString(id) else "Sensitive notification content hidden"
            }
            check(SituateRedaction.redacted(plain(placeholder))) { "Redacted notification not detected" }
            check(SituateRedaction.redacted(conversation("See you soon", placeholder))) { "Redacted message not detected" }
            check(!SituateRedaction.redacted(plain("See you soon"))) { "Ordinary notification read as redacted" }
            val codeNotice = SituateCodeNotices.builder(context, "Synthetic app", "004821").build()
            check(codeNotice.extras.getCharSequence(android.app.Notification.EXTRA_TITLE).toString() == "Sign-in code received")
            check(codeNotice.extras.getCharSequence(android.app.Notification.EXTRA_TEXT).toString() == "004821 · Synthetic app")
            check(codeNotice.extras.getCharSequence(android.app.Notification.EXTRA_BIG_TEXT) == null)
            check(codeNotice.visibility == android.app.Notification.VISIBILITY_PRIVATE)
            // Exercise the same private cross-process path used by the planner.
            val remote = SituateArchiveProvider.request(context, "list", "{}")
            check(JSONObject(remote).has("rows")) { "Archive IPC failed" }
            NotificationArchive(context,directory,namespace).use { archive ->
                fun fixture(i:Int, modes:List<String> = emptyList()) = JSONObject().put("app",if(i%2==0) "test.social" else "test.mail").put("title","SYNTHETIC_PRIVATE_TITLE").put("text","searchable needle$i").put("received",1000+i).put("modes",JSONArray(modes))
                for(i in 1..150) archive.store("fixture$i",fixture(i,if(i%3==0) listOf("dolo") else emptyList()))
                val page=archive.list(JSONObject());check(page.getJSONArray("rows").length()==100);check(page.getBoolean("hasMore"))
                val last=page.getJSONArray("rows").getJSONObject(99)
                val next=archive.list(JSONObject().put("before",last.getLong("received")).put("beforeId",last.getLong("id")))
                check(next.getJSONArray("rows").length()==50)
                check(next.getJSONArray("apps").length()==2)
                check(archive.list(JSONObject().put("since",1101)).getJSONArray("rows").length()==50)
                check(archive.list(JSONObject().put("search","needle42")).getJSONArray("rows").length()==1)
                check(archive.list(JSONObject().put("app","test.mail")).getJSONArray("rows").length()==75)
                check(archive.list(JSONObject().put("mode","dolo")).getJSONArray("rows").length()==50)
                check(archive.list(JSONObject().put("blocked",true)).getJSONArray("rows").length()==50)
                archive.store("fixture42",fixture(42).put("text","replacement"))
                check(archive.list(JSONObject().put("search","needle42")).getJSONArray("rows").length()==0)
                check(archive.list(JSONObject().put("search","replacement")).getJSONArray("rows").length()==1)
                val output=java.io.StringWriter();archive.export(output);check(output.toString().lineSequence().filter { it.isNotBlank() }.count()==150)
            }
            for(file in directory.listFiles().orEmpty()) {
                val bytes=file.readBytes().toString(Charsets.ISO_8859_1)
                check(!bytes.contains("SYNTHETIC_PRIVATE_TITLE"));check(!bytes.contains("needle42"));check(!bytes.contains("test.social"))
            }
            NotificationArchive(context,directory,namespace).use { archive -> check(archive.list(JSONObject().put("search","replacement")).getJSONArray("rows").length()==1);archive.clear();check(archive.list(JSONObject()).getJSONArray("rows").length()==0) }
            android.util.Log.i("BalanceSituate","BALANCE_SITUATE_E2E: OK")
        } catch(error: Throwable) { android.util.Log.e("BalanceSituate","BALANCE_SITUATE_E2E: FAIL",error) }
        finally {
            directory.deleteRecursively()
            val keys=java.security.KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            keys.deleteEntry(namespace+".archive.v1");keys.deleteEntry(namespace+".index.v1")
        }
    }
}
