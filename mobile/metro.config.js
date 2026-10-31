const { getDefaultConfig } = require('expo/metro-config');

const { resolveE2eeDevModule } = require('./metro.e2ee-dev.cjs');

const config = getDefaultConfig(__dirname);
const defaultResolveRequest = config.resolver.resolveRequest;
const devToolsEnabled =
  process.env.EXPO_PUBLIC_E2EE_DEV_TOOLS === '1' && process.env.NODE_ENV !== 'production';

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const override = resolveE2eeDevModule(moduleName, devToolsEnabled, __dirname);
  if (override) {
    return { type: 'sourceFile', filePath: override };
  }
  if (defaultResolveRequest) {
    return defaultResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
