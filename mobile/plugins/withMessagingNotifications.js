const { withAndroidManifest, withDangerousMod } = require('expo/config-plugins');
const fs = require('node:fs');
const path = require('node:path');

const PACKAGE = 'com.groupenzogho.mbolochat';
const SERVICE = `${PACKAGE}.MessagingNotificationService`;
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
    return config;
  });

  return withDangerousMod(config, [
    'android',
    async (config) => {
      const source = path.join(__dirname, 'android', 'MessagingNotificationService.kt');
      const target = path.join(
        config.modRequest.platformProjectRoot,
        'app',
        'src',
        'main',
        'java',
        ...PACKAGE.split('.'),
        'MessagingNotificationService.kt',
      );
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      return config;
    },
  ]);
};
