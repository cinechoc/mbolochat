const { withAndroidManifest, withAppBuildGradle, withDangerousMod } = require('expo/config-plugins');
const fs = require('node:fs');
const path = require('node:path');

const PACKAGE = 'com.groupenzogho.mbolochat';
const SERVICE = `${PACKAGE}.MessagingNotificationService`;
const RECEIVER = `${PACKAGE}.CallActionsReceiver`;
const EXPO_SERVICE = 'expo.modules.notifications.service.ExpoFirebaseMessagingService';

/**
 * Remplace la présentation des notifications distantes par un service natif
 * qui construit une notification de conversation (avatar rond + badge du
 * logo), comme WhatsApp. L'API envoie pour cela des notifications « data-only ».
 */
module.exports = function withMessagingNotifications(config) {
  config = withAndroidManifest(config, (config) => {
    const application = config.modResults.manifest.application?.[0];
    if (!application) {
      return config;
    }
    const services = application.service ?? [];
    // Le service d'expo-notifications afficherait une seconde notification.
    services.push({
      $: {
        'android:name': EXPO_SERVICE,
        'tools:node': 'remove',
      },
    });
    services.push({
      $: {
        'android:name': SERVICE,
        'android:exported': 'false',
      },
      'intent-filter': [
        {
          action: [{ $: { 'android:name': 'com.google.firebase.MESSAGING_EVENT' } }],
        },
      ],
    });
    application.service = services;

    // Actions Accepter/Refuser des notifications d'appel.
    const receivers = application.receiver ?? [];
    if (!receivers.some((entry) => entry.$?.['android:name'] === RECEIVER)) {
      receivers.push({
        $: {
          'android:name': RECEIVER,
          'android:exported': 'false',
        },
      });
    }
    application.receiver = receivers;
    return config;
  });

  // Le service a besoin des classes Firebase (expo-notifications ne les expose
  // pas : il les déclare en `implementation`, donc invisibles pour l'app).
  config = withAppBuildGradle(config, (config) => {
    if (config.modResults.language !== 'groovy') {
      return config;
    }
    let contents = config.modResults.contents;
    if (!contents.includes('firebase-messaging')) {
      contents = contents.replace(
        /dependencies\s*\{/,
        "dependencies {\n    implementation 'com.google.firebase:firebase-messaging:25.0.1'",
      );
    }
    config.modResults.contents = contents;
    return config;
  });

  return withDangerousMod(config, [
    'android',
    async (config) => {
      const targetDir = path.join(
        config.modRequest.platformProjectRoot,
        'app',
        'src',
        'main',
        'java',
        ...PACKAGE.split('.'),
      );
      fs.mkdirSync(targetDir, { recursive: true });
      for (const file of ['MessagingNotificationService.kt', 'CallActionsReceiver.kt']) {
        fs.copyFileSync(path.join(__dirname, 'android', file), path.join(targetDir, file));
      }
      return config;
    },
  ]);
};
