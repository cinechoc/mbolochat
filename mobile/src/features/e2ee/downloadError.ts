interface DownloadErrorShape {
  code?: unknown;
  message?: unknown;
  status?: unknown;
  statusCode?: unknown;
}

const NATIVE_DOWNLOAD_CODE = 'ERR_UNABLE_TO_DOWNLOAD';

function httpStatus(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : null;
}

/** Statut HTTP extrait d'une erreur expo-file-system, sans dépendre de la plateforme. */
export function downloadHttpStatus(cause: unknown): number | null {
  if ((typeof cause !== 'object' || cause === null) && !(cause instanceof Error)) {
    return null;
  }
  const error = cause as DownloadErrorShape;
  const direct = httpStatus(error.status) ?? httpStatus(error.statusCode);
  if (direct !== null) return direct;

  if (typeof error.code === 'string' && error.code !== NATIVE_DOWNLOAD_CODE) {
    return null;
  }
  const message =
    typeof error.message === 'string'
      ? error.message
      : cause instanceof Error
        ? cause.message
        : '';
  const match = /\b(?:status:?\s*|HTTP\s*)(\d{3})\b/i.exec(message);
  return match ? httpStatus(Number(match[1])) : null;
}

export function isUnauthorizedDownload(cause: unknown): boolean {
  return downloadHttpStatus(cause) === 401;
}
