import { requireNativeModule } from 'expo-modules-core';

type ScreenSecurityModule = {
  setSecure(enabled: boolean): boolean;
  isSecure(): boolean;
};

const native = requireNativeModule<ScreenSecurityModule>('MboloScreenSecurity');

/** Protection d'écran (FLAG_SECURE) : aperçu applications récentes et captures. */
export const ScreenSecurity = {
  setSecure: (enabled: boolean): Promise<boolean> => Promise.resolve(native.setSecure(enabled)),
  isSecure: (): Promise<boolean> => Promise.resolve(native.isSecure()),
};

export default ScreenSecurity;
