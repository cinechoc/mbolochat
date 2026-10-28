package com.groupenzogho.mbolochat

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri

/**
 * Actions « Accepter / Refuser » des notifications d'appel : ouvre l'app sur le
 * deep link correspondant, le JS se charge d'émettre call:accept / call:reject
 * (seul détenteur du jeton d'authentification).
 */
class CallActionsReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val callId = intent.getStringExtra("callId") ?: return
    val conversationId = intent.getStringExtra("conversationId").orEmpty()
    val action = when (intent.action) {
      "com.groupenzogho.mbolochat.call.ACCEPT" -> "accept"
      "com.groupenzogho.mbolochat.call.DECLINE" -> "decline"
      else -> return
    }

    val open = Intent(
      Intent.ACTION_VIEW,
      Uri.parse("mbolochat://call/$callId?conversationId=$conversationId&action=$action"),
      context,
      MainActivity::class.java,
    )
    open.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
    context.startActivity(open)

    // L'appel a été traité : la notification d'appel disparaît.
    (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
      .cancel(callId.hashCode())
  }
}
