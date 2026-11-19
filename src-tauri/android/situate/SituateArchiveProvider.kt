package app.balance.local

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.net.Uri
import android.os.Binder
import android.os.Process
import android.os.ParcelFileDescriptor
import org.json.JSONObject

/** App-private IPC: archive keys, writes and cached notification actions share one process. */
class SituateArchiveProvider : ContentProvider() {
    companion object {
        fun request(context: Context, action: String, query: String): String {
            val uri = Uri.parse("content://${context.packageName}.situate.archive").buildUpon()
                .appendPath(action).appendQueryParameter("query", query).build()
            return context.contentResolver.openInputStream(uri)?.bufferedReader()?.use { it.readText() }
                ?: throw IllegalStateException("Notification archive unavailable")
        }
    }
    override fun onCreate() = true
    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        check(Binder.getCallingUid() == Process.myUid())
        val context = requireNotNull(context)
        require(mode == "r")
        val query = JSONObject(uri.getQueryParameter("query") ?: "{}")
        val result = NotificationArchive(context).use { archive ->
            when (uri.lastPathSegment) {
                "list" -> archive.list(query).toString()
                "open" -> { archive.open(query.getLong("id")); "{}" }
                "delete-all" -> { archive.clear(); "{}" }
                else -> throw IllegalArgumentException("Unknown archive action")
            }
        }
        // History pages can exceed Binder's transaction limit. Only the pipe
        // descriptor crosses Binder; encrypted archive data stays app-private.
        return openPipeHelper(uri, "application/json", null, result) { output, _, _, _, text ->
            try { ParcelFileDescriptor.AutoCloseOutputStream(output).bufferedWriter().use { it.write(text) } }
            catch (_: Exception) { /* A caller may close its reader early. */ }
        }
    }

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor? = throw UnsupportedOperationException()
    override fun getType(uri: Uri): String? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? = throw UnsupportedOperationException()
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = throw UnsupportedOperationException()
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = throw UnsupportedOperationException()
}
