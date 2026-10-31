import { NativeModule, requireNativeModule } from 'expo-modules-core';

export type AccountCreated = {
  account_pickle: string;
  curve25519: string;
  ed25519: string;
};

export type OneTimeKey = { key_id: string; key: string };
export type OneTimeKeysGenerated = { account_pickle: string; keys: OneTimeKey[] };
export type OutboundCreated = {
  session_pickle: string;
  session_id: string;
  message_type: string;
  message: string;
};
export type OlmEnvelope = OutboundCreated;
export type InboundCreated = OlmEnvelope & {
  account_pickle: string;
  plaintext_b64: string;
};
export type PlaintextDecrypted = { session_pickle: string; plaintext_b64: string };
export type FileEncrypted = {
  file_key_b64: string;
  nonce_b64: string;
  sha256_hex: string;
  plaintext_size: number;
  ciphertext_size: number;
};

declare class MboloCryptoModule extends NativeModule {
  version(): string;
  createAccount(pickleKey: string): Promise<string>;
  generateOneTimeKeys(accountPickle: string, pickleKey: string, count: number): Promise<string>;
  createOutbound(
    accountPickle: string,
    pickleKey: string,
    identityKey: string,
    oneTimeKey: string,
    plaintextB64: string,
  ): Promise<string>;
  encrypt(sessionPickle: string, pickleKey: string, plaintextB64: string): Promise<string>;
  createInbound(
    accountPickle: string,
    pickleKey: string,
    identityKey: string,
    prekeyMessage: string,
  ): Promise<string>;
  decrypt(
    sessionPickle: string,
    pickleKey: string,
    messageType: string,
    messageB64: string,
  ): Promise<string>;
  encryptFile(inputPath: string, outputPath: string): Promise<string>;
  decryptFile(
    inputPath: string,
    outputPath: string,
    keyB64: string,
    nonceB64: string,
    expectedSha256: string,
  ): Promise<string>;
}

type NativeResult<T> = { ok: true; data: T } | { ok: false; error: string };

const native = requireNativeModule<MboloCryptoModule>('MboloCrypto');

async function invoke<T>(pending: Promise<string>): Promise<T> {
  const parsed = JSON.parse(await pending) as NativeResult<T>;
  if (!parsed.ok) {
    throw new Error(`mbolo-crypto: ${parsed.error}`);
  }
  return parsed.data;
}

export const MboloCrypto = {
  version: native.version(),
  createAccount: (pickleKey: string) => invoke<AccountCreated>(native.createAccount(pickleKey)),
  generateOneTimeKeys: (accountPickle: string, pickleKey: string, count: number) =>
    invoke<OneTimeKeysGenerated>(native.generateOneTimeKeys(accountPickle, pickleKey, count)),
  createOutbound: (
    accountPickle: string,
    pickleKey: string,
    identityKey: string,
    oneTimeKey: string,
    plaintextB64: string,
  ) =>
    invoke<OutboundCreated>(
      native.createOutbound(accountPickle, pickleKey, identityKey, oneTimeKey, plaintextB64),
    ),
  encrypt: (sessionPickle: string, pickleKey: string, plaintextB64: string) =>
    invoke<OlmEnvelope>(native.encrypt(sessionPickle, pickleKey, plaintextB64)),
  createInbound: (
    accountPickle: string,
    pickleKey: string,
    identityKey: string,
    prekeyMessage: string,
  ) =>
    invoke<InboundCreated>(
      native.createInbound(accountPickle, pickleKey, identityKey, prekeyMessage),
    ),
  decrypt: (sessionPickle: string, pickleKey: string, messageType: string, messageB64: string) =>
    invoke<PlaintextDecrypted>(native.decrypt(sessionPickle, pickleKey, messageType, messageB64)),
  encryptFile: (inputPath: string, outputPath: string) =>
    invoke<FileEncrypted>(native.encryptFile(inputPath, outputPath)),
  decryptFile: (
    inputPath: string,
    outputPath: string,
    keyB64: string,
    nonceB64: string,
    expectedSha256: string,
  ) =>
    invoke<{ plaintext_size: number }>(
      native.decryptFile(inputPath, outputPath, keyB64, nonceB64, expectedSha256),
    ),
};

export default MboloCrypto;
