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
