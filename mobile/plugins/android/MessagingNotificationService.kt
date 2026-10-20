package com.groupenzogho.mbolochat

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
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.content.ContextCompat
import androidx.core.graphics.drawable.IconCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import java.net.HttpURLConnection
import java.net.URL

/**
 * Affiche les messages entrants comme WhatsApp : avatar rond de l'expéditeur
 * avec le logo de l'application en badge, dans une notification de
 * conversation (Android 11+).
 *
 * L'API envoie des notifications « data-only » : expo-notifications ne les
 * présente donc pas et c'est ce service qui construit la notification.
 */
class MessagingNotificationService : FirebaseMessagingService() {
  override fun onMessageReceived(message: RemoteMessage) {
    val data = message.data
    if (data["type"] != "message") {
      return
    }
    val conversationId = data["conversationId"]?.takeIf { it.isNotEmpty() } ?: return
    val title = data["title"].orEmpty().ifEmpty { "MboloChat" }
    val text = data["message"].orEmpty()
    val senderName = data["senderName"]?.takeIf { it.isNotEmpty() } ?: title
    val groupName = data["groupName"]?.takeIf { it.isNotEmpty() }
    val avatarUrl = data["avatarUrl"]?.takeIf { it.isNotEmpty() }

    // Le téléchargement de la photo ne doit pas bloquer le thread principal.
    Thread {
      try {
        val avatar = avatarUrl?.let { download(it) }
        show(conversationId, title, text, senderName, groupName, avatar)
      } finally {
        stopSelf()
      }
    }.start()
  }

  override fun onNewToken(token: String) {
    // Le jeton Expo est récupéré directement par expo-notifications.
  }

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

  private fun show(
    conversationId: String,
    title: String,
    text: String,
    senderName: String,
    groupName: String?,
    avatar: Bitmap?,
  ) {
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      if (manager.getNotificationChannel(CHANNEL_ID) == null) {
        manager.createNotificationChannel(
          NotificationChannel(CHANNEL_ID, "Messages", NotificationManager.IMPORTANCE_HIGH).apply {
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 200, 150, 200)
            lightColor = ContextCompat.getColor(this@MessagingNotificationService, R.color.notification_icon_color)
          },
        )
      }
    }

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

    val sender = Person.Builder()
      .setName(senderName)
      .setKey(conversationId)
      .apply { avatar?.let { setIcon(IconCompat.createWithBitmap(circular(it))) } }
      .build()

    val style = NotificationCompat.MessagingStyle(Person.Builder().setName("Moi").build())
      .setConversationTitle(groupName)
      .addMessage(text, System.currentTimeMillis(), sender)

    val builder = NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(R.drawable.notification_icon)
      .setColor(ContextCompat.getColor(this, R.color.notification_icon_color))
      .setStyle(style)
      .setContentTitle(title)
      .setContentText(text)
      .setWhen(System.currentTimeMillis())
      .setShowWhen(true)
      .setContentIntent(pending)
      .setAutoCancel(true)
      .setCategory(NotificationCompat.CATEGORY_MESSAGE)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      builder.setShortcutId(conversationId)
    }

    NotificationManagerCompat.from(this).notify(conversationId, NOTIFICATION_ID, builder.build())
  }

  companion object {
    private const val CHANNEL_ID = "messages"
    private const val NOTIFICATION_ID = 1
  }
}
