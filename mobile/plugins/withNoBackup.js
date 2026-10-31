const { AndroidConfig, withAndroidManifest, withDangerousMod } = require('expo/config-plugins');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

/**
 * Exclut explicitement du cloud backup et du transfert direct Android 12+ la
 * base SQLCipher, les pickles et le blob de clés Keystore.
 */
module.exports = function withNoBackup(config) {
  config = withAndroidManifest(config, (config) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(config.modResults);
    app.$['android:allowBackup'] = 'false';
    app.$['android:fullBackupContent'] = 'false';
    app.$['android:dataExtractionRules'] = '@xml/data_extraction_rules';
    return config;
  });
  config = withDangerousMod(config, [
    'android',
    (config) => {
      const dir = join(config.modRequest.platformProjectRoot, 'app/src/main/res/xml');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'data_extraction_rules.xml'),
        `<?xml version="1.0" encoding="utf-8"?>
<data-extraction-rules>
  <cloud-backup>
    <exclude domain="database" path="." />
    <exclude domain="sharedpref" path="." />
    <exclude domain="file" path="." />
  </cloud-backup>
  <device-transfer>
    <exclude domain="database" path="." />
    <exclude domain="sharedpref" path="." />
    <exclude domain="file" path="." />
  </device-transfer>
</data-extraction-rules>
`,
      );
      return config;
    },
  ]);
  return config;
};
