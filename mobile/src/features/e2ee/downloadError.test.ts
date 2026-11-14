import { describe, expect, it } from 'vitest';

import { downloadHttpStatus, isUnauthorizedDownload } from './downloadError';

describe('erreurs de téléchargement expo-file-system', () => {
  it('lit le format Android, avec deux-points', () => {
    const error = new Error('Unable to download a file: response has status: 401');
    Object.assign(error, { code: 'ERR_UNABLE_TO_DOWNLOAD' });
    expect(isUnauthorizedDownload(error)).toBe(true);
  });

  it('lit le format iOS sans deux-points après status', () => {
    const error = new Error('Unable to download a file: response has status 401');
    Object.assign(error, { code: 'ERR_UNABLE_TO_DOWNLOAD' });
    expect(isUnauthorizedDownload(error)).toBe(true);
  });

  it('lit le format de la tâche iOS « HTTP 401 »', () => {
    expect(
      downloadHttpStatus(new Error('Unable to download a file: server returned HTTP 401')),
    ).toBe(401);
  });

  it('privilégie une propriété de statut explicite si elle existe', () => {
    expect(downloadHttpStatus({ message: 'peu importe', status: 401 })).toBe(401);
    expect(downloadHttpStatus({ message: 'peu importe', statusCode: 404 })).toBe(404);
  });

  it('ne confond pas un autre code natif avec un 401', () => {
    expect(
      isUnauthorizedDownload(
        Object.assign(new Error('response has status: 401'), { code: 'ERR_NETWORK' }),
      ),
    ).toBe(false);
  });

  it('ne rafraîchit pas sur un autre statut', () => {
    expect(isUnauthorizedDownload(new Error('Unable to download a file: response has status: 404'))).toBe(
      false,
    );
    expect(isUnauthorizedDownload(new Error('UnableToDownload 404'))).toBe(false);
  });
});
