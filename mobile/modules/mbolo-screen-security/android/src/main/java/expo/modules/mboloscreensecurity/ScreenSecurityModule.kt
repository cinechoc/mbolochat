package expo.modules.mboloscreensecurity

import android.app.Activity
import android.view.WindowManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Pose ou retire FLAG_SECURE sur la fenêtre de l'activité : pendant que le
 * drapeau est posé, la vignette « applications récentes » et les captures
 * d'écran montrent un écran neutre au lieu du contenu déchiffré.
 *
 * L'app est mono-activité : poser le drapeau à l'entrée d'un écran sensible et
 * le retirer au démontage donne un comportement par écran.
 */
class ScreenSecurityModule : Module() {
  private fun currentActivity(): Activity? =
    appContext.currentActivity ?: (appContext.reactContext as? Activity)

  override fun definition() = ModuleDefinition {
    Name("MboloScreenSecurity")

    Function("setSecure") { enabled: Boolean ->
      val activity = currentActivity() ?: return@Function false
      if (enabled) {
        activity.window.setFlags(
          WindowManager.LayoutParams.FLAG_SECURE,
          WindowManager.LayoutParams.FLAG_SECURE,
        )
      } else {
        activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
      }
      true
    }

    Function("isSecure") {
      val activity = currentActivity() ?: return@Function false
      (activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE) != 0
    }
  }
}
