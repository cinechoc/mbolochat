package com.groupenzogho.mbolochat

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.Rect
import android.media.AudioAttributes
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.content.ContextCompat
import androidx.core.graphics.drawable.IconCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Notifications « data-only » construites côté natif, façon WhatsApp :
 * une notification par conversation (historique + compteur de non-lus),
 * un résumé groupé, et des notifications d'appel plein écran.
 */
class MessagingNotificationService : FirebaseMessagingService() {
  private data class HistoryEntry(val sender: String, val text: String, val time: Long)

  override fun onMessageReceived(message: RemoteMessage) {
    val data = message.data
    when (data["type"]) {
      "call" -> {
        showCall(data)
        return
      }
      "call-cancel" -> {
        cancelCall(data)
        return
      }
      "call-missed" -> {
        showMissed(data)
        return
      }
      "message" -> Unit
      else -> return
    }
    val conversationId = data["conversationId"]?.takeIf { it.isNotEmpty() } ?: return
    val title = data["title"].orEmpty().ifEmpty { "MboloChat" }
    val text = data["message"].orEmpty().ifEmpty { "Nouveau message" }
    val senderName = data["senderName"]?.takeIf { it.isNotEmpty() } ?: title
    val groupName = data["groupName"]?.takeIf { it.isNotEmpty() }
    val avatarUrl = data["avatarUrl"]?.takeIf { it.isNotEmpty() }
    val silent = data["silent"] == "1"
    val unread = data["unreadCount"]?.toIntOrNull()

    // Le téléchargement de la photo ne doit pas bloquer le thread principal.
    Thread {
      try {
        val avatar = avatarUrl?.let { download(it) }
        showMessage(conversationId, title, text, senderName, groupName, avatar, silent, unread)
      } finally {
        stopSelf()
      }
    }.start()
  }

  override fun onNewToken(token: String) {
    // Le jeton Expo est récupéré directement par expo-notifications.
  }

  private val prefs by lazy { getSharedPreferences(PREFS, Context.MODE_PRIVATE) }

  private fun download(url: String): Bitmap? = runCatching {
    val connection = URL(url).openConnection() as HttpURLConnection
    connection.connectTimeout = 5000
    connection.readTimeout = 5000
    connection.inputStream.use { BitmapFactory.decodeStream(it) }
  }.getOrNull()

  /** Découpe la photo en cercle, comme sur WhatsApp. */
  private fun circular(bitmap: Bitmap): Bitmap {
    val size = minOf(bitmap.width, bitmap.height)
    val output = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(output)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    canvas.drawCircle(size / 2f, size / 2f, size / 2f, paint)
    paint.xfermode = PorterDuffXfermode(PorterDuff.Mode.SRC_IN)
    val left = (bitmap.width - size) / 2
    val top = (bitmap.height - size) / 2
    canvas.drawBitmap(bitmap, Rect(left, top, left + size, top + size), Rect(0, 0, size, size), paint)
    return output
  }

  /* --------------------------------- messages --------------------------------- */

  private fun ensureMessageChannel(silent: Boolean) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    val id = if (silent) CHANNEL_SILENT else CHANNEL_ID
    if (manager.getNotificationChannel(id) != null) return
    val channel = NotificationChannel(
      id,
      if (silent) "Messages (sans son)" else "Messages",
      NotificationManager.IMPORTANCE_HIGH,
    ).apply {
      enableVibration(true)
      vibrationPattern = longArrayOf(0, 200, 150, 200)
      lightColor = ContextCompat.getColor(this@MessagingNotificationService, R.color.notification_icon_color)
      if (silent) setSound(null, null)
    }
    manager.createNotificationChannel(channel)
  }

  private fun showMessage(
    conversationId: String,
    title: String,
    text: String,
    senderName: String,
    groupName: String?,
    avatar: Bitmap?,
    silent: Boolean,
    unread: Int?,
  ) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      val granted = ContextCompat.checkSelfPermission(
        this,
        android.Manifest.permission.POST_NOTIFICATIONS,
      ) == android.content.pm.PackageManager.PERMISSION_GRANTED
      if (!granted) return
    }
    ensureMessageChannel(silent)

    val count = unread ?: (prefs.getInt(countKey(conversationId), 0) + 1)
    val previous = loadHistory(conversationId)
    val current = HistoryEntry(senderName, text, System.currentTimeMillis())
    val history = (previous + current).takeLast(MAX_HISTORY)
    saveHistory(conversationId, history)
    prefs.edit().putInt(countKey(conversationId), count).apply()

    val intent = Intent(
      Intent.ACTION_VIEW,
      Uri.parse("mbolochat://chat/$conversationId"),
      this,
      MainActivity::class.java,
    )
    intent.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
    val pending = PendingIntent.getActivity(
      this,
      conversationId.hashCode(),
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    val style = NotificationCompat.MessagingStyle(Person.Builder().setName("Moi").build())
      .setConversationTitle(groupName)
    for (entry in history) {
      val person = Person.Builder().setName(entry.sender).setKey(conversationId).build()
      style.addMessage(entry.text, entry.time, person)
    }

    val builder = NotificationCompat.Builder(this, if (silent) CHANNEL_SILENT else CHANNEL_ID)
      .setSmallIcon(R.drawable.notification_icon)
      .setColor(ContextCompat.getColor(this, R.color.notification_icon_color))
      .setStyle(style)
      .setContentTitle(title)
      .setContentText(text)
      .setWhen(current.time)
      .setShowWhen(true)
      .setNumber(count)
      .setContentIntent(pending)
      .setAutoCancel(true)
      .setCategory(NotificationCompat.CATEGORY_MESSAGE)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setGroup(GROUP_KEY)
      .setGroupSummary(false)

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      builder.setShortcutId(conversationId)
    }
    if (avatar != null) {
      val sender = Person.Builder()
        .setName(senderName)
        .setKey(conversationId)
        .setIcon(IconCompat.createWithBitmap(circular(avatar)))
        .build()
      // L'avatar ne s'attache qu'à la personne du message courant : l'historique
      // garde les noms, pas les images (elles ne survivent pas au processus).
      builder.setStyle(
        NotificationCompat.MessagingStyle(Person.Builder().setName("Moi").build())
          .setConversationTitle(groupName)
          .apply {
            for (entry in history) {
              if (entry === current || entry.time == current.time) {
                addMessage(entry.text, entry.time, sender)
              } else {
                addMessage(
                  entry.text,
                  entry.time,
                  Person.Builder().setName(entry.sender).setKey(conversationId).build(),
                )
              }
            }
          },
      )
    }

    // Tag = identifiant de conversation : une notification par discussion.
    NotificationManagerCompat.from(this)
      .notify(conversationId, MESSAGE_NOTIFICATION_ID, builder.build())
    updateSummary()
  }

  /** Résumé « MboloChat » : total des non-lus de toutes les conversations. */
  private fun updateSummary() {
    val total = prefs.all
      .filterKeys { it.startsWith(COUNT_PREFIX) }
      .values
      .sumOf { (it as? Int) ?: 0 }
    val manager = NotificationManagerCompat.from(this)
    if (total <= 0) {
      manager.cancel(SUMMARY_ID)
      return
    }
    ensureMessageChannel(true)
    val open = Intent(this, MainActivity::class.java)
    open.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
    val pending = PendingIntent.getActivity(
      this,
      SUMMARY_ID,
      open,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val builder = NotificationCompat.Builder(this, CHANNEL_SILENT)
      .setSmallIcon(R.drawable.notification_icon)
      .setColor(ContextCompat.getColor(this, R.color.notification_icon_color))
      .setContentTitle("MboloChat")
      .setContentText(if (total > 1) "$total nouveaux messages" else "Nouveau message")
      .setNumber(total)
      .setContentIntent(pending)
      .setAutoCancel(true)
      .setCategory(NotificationCompat.CATEGORY_MESSAGE)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setGroup(GROUP_KEY)
      .setGroupSummary(true)
    manager.notify(SUMMARY_ID, builder.build())
  }

  private fun loadHistory(conversationId: String): List<HistoryEntry> {
    val raw = prefs.getString(HISTORY_PREFIX + conversationId, null) ?: return emptyList()
    return runCatching {
      val array = JSONArray(raw)
      buildList {
        for (index in 0 until array.length()) {
          val item = array.getJSONObject(index)
          add(
            HistoryEntry(
              item.optString("sender"),
              item.optString("text"),
              item.optLong("time"),
            ),
          )
        }
      }
    }.getOrElse { emptyList() }
  }

  private fun saveHistory(conversationId: String, entries: List<HistoryEntry>) {
    val array = JSONArray()
    for (entry in entries) {
      array.put(
        JSONObject()
          .put("sender", entry.sender)
          .put("text", entry.text)
          .put("time", entry.time),
      )
    }
    prefs.edit().putString(HISTORY_PREFIX + conversationId, array.toString()).apply()
  }

  /* ---------------------------------- appels ---------------------------------- */

  private fun showCall(data: Map<String, String>) {
    val callId = data["callId"]?.takeIf { it.isNotEmpty() } ?: return
    val conversationId = data["conversationId"].orEmpty()
    val title = data["title"].orEmpty().ifEmpty { "MboloChat" }
    val avatarUrl = data["avatarUrl"]?.takeIf { it.isNotEmpty() }
    val video = data["video"] == "1"

    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      if (manager.getNotificationChannel(CHANNEL_CALLS) == null) {
        val audioAttributes = AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
          .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
          .build()
        manager.createNotificationChannel(
          NotificationChannel(CHANNEL_CALLS, "Appels", NotificationManager.IMPORTANCE_HIGH).apply {
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 700, 500, 700)
            setSound(Settings.System.DEFAULT_RINGTONE_URI, audioAttributes)
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
          },
        )
      }
    }

    val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    val openIntent = Intent(
      Intent.ACTION_VIEW,
      Uri.parse("mbolochat://call/$callId?conversationId=$conversationId"),
      this,
      MainActivity::class.java,
    )
    openIntent.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
    val fullScreen = PendingIntent.getActivity(this, callId.hashCode(), openIntent, flags)
    val accept = PendingIntent.getBroadcast(
      this, callId.hashCode() + 1, callActionIntent(callId, conversationId, "ACCEPT"), flags,
    )
    val decline = PendingIntent.getBroadcast(
      this, callId.hashCode() + 2, callActionIntent(callId, conversationId, "DECLINE"), flags,
    )
    val dismiss = PendingIntent.getBroadcast(
      this, callId.hashCode() + 3, callActionIntent(callId, conversationId, "DECLINE"), flags,
    )

    val builder = NotificationCompat.Builder(this, CHANNEL_CALLS)
      .setSmallIcon(R.drawable.notification_icon)
      .setColor(ContextCompat.getColor(this, R.color.notification_icon_color))
      .setContentTitle(title)
      .setContentText(if (video) "Appel vidéo entrant" else "Appel vocal entrant")
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setPriority(NotificationCompat.PRIORITY_MAX)
      .setOngoing(true)
      .setAutoCancel(false)
      .setTimeoutAfter(CALL_TIMEOUT_MS)
      .setFullScreenIntent(fullScreen, true)
      .setContentIntent(fullScreen)
      .setDeleteIntent(dismiss)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .addAction(0, "Refuser", decline)
      .addAction(0, "Accepter", accept)

    fun publish(bitmap: Bitmap?) {
      if (bitmap != null) {
        builder.setLargeIcon(circular(bitmap))
      }
      NotificationManagerCompat.from(this).notify(callId.hashCode(), builder.build())
    }

    if (avatarUrl == null) {
      publish(null)
      stopSelf()
      return
    }
    Thread {
      try {
        publish(avatarUrl?.let { download(it) })
      } finally {
        stopSelf()
      }
    }.start()
  }

  private fun cancelCall(data: Map<String, String>) {
    val callId = data["callId"]?.takeIf { it.isNotEmpty() } ?: return
    (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
      .cancel(callId.hashCode())
  }

  /** L'appel a expiré : la sonnerie laisse place à « Appel manqué ». */
  private fun showMissed(data: Map<String, String>) {
    val callId = data["callId"]?.takeIf { it.isNotEmpty() } ?: return
    val conversationId = data["conversationId"].orEmpty()
    val title = data["title"].orEmpty().ifEmpty { "MboloChat" }
    val video = data["video"] == "1"

    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    manager.cancel(callId.hashCode())
    ensureMessageChannel(false)

    val intent = Intent(
      Intent.ACTION_VIEW,
      Uri.parse("mbolochat://chat/$conversationId"),
      this,
      MainActivity::class.java,
    )
    intent.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
    val pending = PendingIntent.getActivity(
      this,
      callId.hashCode(),
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    val builder = NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(R.drawable.notification_icon)
      .setColor(ContextCompat.getColor(this, R.color.notification_icon_color))
      .setContentTitle(title)
      .setContentText(if (video) "Appel vidéo manqué" else "Appel manqué")
      .setWhen(System.currentTimeMillis())
      .setShowWhen(true)
      .setContentIntent(pending)
      .setAutoCancel(true)
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setPriority(NotificationCompat.PRIORITY_HIGH)

    NotificationManagerCompat.from(this).notify(callId.hashCode(), builder.build())
  }

  private fun callActionIntent(callId: String, conversationId: String, action: String): Intent =
    Intent(this, CallActionsReceiver::class.java).apply {
      this.action = "com.groupenzogho.mbolochat.call.$action"
      putExtra("callId", callId)
      putExtra("conversationId", conversationId)
    }

  companion object {
    private const val CHANNEL_ID = "messages"
    private const val CHANNEL_SILENT = "messages_silent"
    private const val CHANNEL_CALLS = "calls"
    private const val GROUP_KEY = "mbolochat_messages"
    private const val PREFS = "mbolo_notifications"
    private const val HISTORY_PREFIX = "history_"
    private const val COUNT_PREFIX = "count_"
    private const val MESSAGE_NOTIFICATION_ID = 1
    private const val SUMMARY_ID = 9001
    private const val MAX_HISTORY = 6
    private const val CALL_TIMEOUT_MS = 35_000L
  }
}
