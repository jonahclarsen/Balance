package app.balance.local

import android.app.PendingIntent
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.service.notification.StatusBarNotification
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.Closeable
import java.io.File
import java.io.Writer
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.Mac
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Separate device-bound key, ciphertext-only payloads, keyed search tokens, no backups. */
class NotificationArchive(private val context: Context, directory: File = context.noBackupFilesDir, namespace: String = "balance.situate") : Closeable {
    private val db = SQLiteDatabase.openOrCreateDatabase(File(directory,"situate-notifications.sqlite3"),null)
    companion object {
        private val intents=object : LinkedHashMap<Long,PendingIntent>(128,0.75f,true) {
            override fun removeEldestEntry(eldest: MutableMap.MutableEntry<Long,PendingIntent>?): Boolean = size>500
        }
        @Synchronized private fun key(alias: String, hmac: Boolean=false): SecretKey {
            val store=KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            (store.getKey(alias,null) as? SecretKey)?.let { return it }
            val algorithm=if(hmac) KeyProperties.KEY_ALGORITHM_HMAC_SHA256 else KeyProperties.KEY_ALGORITHM_AES
            val builder=KeyGenParameterSpec.Builder(alias,if(hmac) KeyProperties.PURPOSE_SIGN else KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            if(!hmac) builder.setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setRandomizedEncryptionRequired(true)
            return KeyGenerator.getInstance(algorithm,"AndroidKeyStore").apply { init(builder.build()) }.generateKey()
        }
    }
    private val encryption=key(namespace+".archive.v1")
    private val indexing=key(namespace+".index.v1",true)
    init {
        db.enableWriteAheadLogging()
        db.rawQuery("PRAGMA secure_delete=ON",null).use { it.moveToFirst() }
        db.execSQL("CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY, identity TEXT UNIQUE NOT NULL, received INTEGER NOT NULL, opened INTEGER NOT NULL DEFAULT 0, app TEXT NOT NULL, blocked INTEGER NOT NULL, payload BLOB NOT NULL)")
        db.execSQL("CREATE TABLE IF NOT EXISTS tokens(token TEXT NOT NULL, notification INTEGER NOT NULL, PRIMARY KEY(token,notification)) WITHOUT ROWID")
        db.execSQL("CREATE INDEX IF NOT EXISTS received_idx ON notifications(received DESC,id DESC)")
        db.execSQL("CREATE INDEX IF NOT EXISTS opened_idx ON notifications(opened DESC,id DESC)")
        db.execSQL("CREATE INDEX IF NOT EXISTS app_idx ON notifications(app,received DESC)")
    }
    private fun tag(text: String): String = Base64.encodeToString(Mac.getInstance("HmacSHA256").apply { init(indexing) }.doFinal(text.toByteArray(Charsets.UTF_8)),Base64.NO_WRAP)
    private fun seal(text: String): ByteArray {
        val cipher=Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE,encryption)
        cipher.updateAAD("balance.situate.notification.v1".toByteArray())
        return cipher.iv + cipher.doFinal(text.toByteArray(Charsets.UTF_8))
    }
    private fun unseal(bytes: ByteArray): JSONObject {
        val cipher=Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.DECRYPT_MODE,encryption,GCMParameterSpec(128,bytes.copyOfRange(0,12)))
        cipher.updateAAD("balance.situate.notification.v1".toByteArray())
        return JSONObject(String(cipher.doFinal(bytes.copyOfRange(12,bytes.size)),Charsets.UTF_8))
    }
    private fun words(text: String) = text.lowercase(java.util.Locale.ROOT).split(Regex("[^\\p{L}\\p{N}]+")).filter { it.isNotEmpty() }.distinct().take(500)
    fun record(sbn: StatusBarNotification, blockedModes: List<String>, modes: List<String>) {
        val notification=sbn.notification
        val extras=notification.extras
        val title=extras.getCharSequence("android.title")?.toString().orEmpty().take(4096)
        val text=(extras.getCharSequence("android.bigText") ?: extras.getCharSequence("android.text"))?.toString().orEmpty().take(32768)
        val appName=try { context.packageManager.getApplicationLabel(context.packageManager.getApplicationInfo(sbn.packageName,0)).toString() } catch(_: Exception) { sbn.packageName }
        val value=JSONObject().put("appName",appName).put("blockedModes",JSONArray(blockedModes)).put("app",sbn.packageName).put("title",title).put("text",text).put("received",sbn.postTime).put("modes",JSONArray(modes))
        store(tag("identity:"+sbn.key),value,notification.contentIntent)
    }
    internal fun store(identity: String,value: JSONObject,intent: PendingIntent?=null) {
        val received=value.getLong("received"); val modes=value.getJSONArray("modes"); val app=value.getString("app")
        db.beginTransaction()
        try {
            db.execSQL("INSERT INTO notifications(identity,received,app,blocked,payload) VALUES(?,?,?,?,?) ON CONFLICT(identity) DO UPDATE SET received=excluded.received,app=excluded.app,blocked=excluded.blocked,payload=excluded.payload", arrayOf(identity,received,tag("app:"+app),if((value.optJSONArray("blockedModes") ?: modes).length()>0) 1 else 0,seal(value.toString())))
            val id=db.rawQuery("SELECT id FROM notifications WHERE identity=?",arrayOf(identity)).use { it.moveToFirst(); it.getLong(0) }
            db.execSQL("DELETE FROM tokens WHERE notification=?",arrayOf(id))
            val tokens=words(value.optString("title")+" "+value.optString("text")+" "+app).map { tag("word:"+it) }.toMutableSet()
            for(i in 0 until modes.length()) tokens.add(tag("mode:"+modes.getString(i)))
            for(token in tokens) db.execSQL("INSERT OR IGNORE INTO tokens(token,notification) VALUES(?,?)",arrayOf(token,id))
            db.setTransactionSuccessful()
            if(intent!=null) synchronized(intents) { intents[id]=intent }
        } finally { db.endTransaction() }
    }
    fun list(query: JSONObject): JSONObject {
        val where=mutableListOf<String>(); val args=mutableListOf<String>()
        val app=query.optString("app"); if(app.isNotBlank()) { where.add("app=?"); args.add(tag("app:"+app)) }
        if(query.optBoolean("blocked")) where.add("blocked=1")
        val tokens=words(query.optString("search")).map { tag("word:"+it) }.toMutableList()
        val mode=query.optString("mode"); if(mode.isNotBlank()) tokens.add(tag("mode:"+mode))
        for(token in tokens) { where.add("id IN (SELECT notification FROM tokens WHERE token=?)"); args.add(token) }
        val order=if(query.optString("sort")=="opened") "opened" else "received"
        val before=query.optLong("before",Long.MAX_VALUE); val beforeId=query.optLong("beforeId",Long.MAX_VALUE)
        where.add("($order < ? OR ($order = ? AND id < ?))"); args.add(before.toString()); args.add(before.toString()); args.add(beforeId.toString())
        val since=query.optLong("since",0); if(since>0) { where.add("$order>=?"); args.add(since.toString()) }
        val rows=JSONArray()
        db.rawQuery("SELECT id,received,opened,payload FROM notifications WHERE "+where.joinToString(" AND ")+" ORDER BY $order DESC,id DESC LIMIT 100",args.toTypedArray()).use { cursor ->
            while(cursor.moveToNext()) { val value=unseal(cursor.getBlob(3)); value.put("id",cursor.getLong(0)).put("received",cursor.getLong(1)).put("opened",cursor.getLong(2)); rows.put(value) }
        }
        val apps=JSONArray()
        db.rawQuery("SELECT n.payload,a.count FROM notifications n JOIN (SELECT MIN(id) id,COUNT(*) count FROM notifications GROUP BY app) a ON n.id=a.id",null).use { c ->
            while(c.moveToNext()) { val entry=unseal(c.getBlob(0)); apps.put(JSONObject().put("id",entry.getString("app")).put("name",entry.optString("appName",entry.getString("app"))).put("count",c.getLong(1))) }
        }
        return JSONObject().put("rows",rows).put("hasMore",rows.length()==100).put("apps",apps)
    }
    fun open(id: Long) {
        val value=db.rawQuery("SELECT payload FROM notifications WHERE id=?",arrayOf(id.toString())).use { if(it.moveToFirst()) unseal(it.getBlob(0)) else null } ?: return
        db.execSQL("UPDATE notifications SET opened=? WHERE id=?",arrayOf(System.currentTimeMillis(),id))
        val pending=synchronized(intents) { intents[id] }
        if(pending!=null) try { pending.send(); return } catch(_: PendingIntent.CanceledException) { }
        context.packageManager.getLaunchIntentForPackage(value.getString("app"))?.let { context.startActivity(it.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)) }
    }
    fun export(writer: Writer) {
        db.rawQuery("SELECT id,received,opened,payload FROM notifications ORDER BY received DESC,id DESC",null).use { c ->
            while(c.moveToNext()) { val value=unseal(c.getBlob(3)); value.put("id",c.getLong(0)).put("received",c.getLong(1)).put("opened",c.getLong(2)); writer.write(value.toString()); writer.write("\n") }
        }
    }
    fun clear() { db.beginTransaction(); try { db.execSQL("DELETE FROM tokens"); db.execSQL("DELETE FROM notifications"); db.setTransactionSuccessful() } finally { db.endTransaction() }; synchronized(intents) { intents.clear() }; db.rawQuery("PRAGMA wal_checkpoint(TRUNCATE)",null).use { it.moveToFirst() } }
    override fun close() { db.close() }
}
