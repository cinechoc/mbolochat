/** Âge minimum autorisé pour créer un compte. */
export const MIN_AGE = 13;
/** Au-delà, la date de naissance est tenue pour une erreur de saisie. */
export const MAX_AGE = 120;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Âge révolu à la date `now`, calculé côté serveur. Un 29 février est fêté le
 * 28 février les années non bissextiles. Renvoie null si la date est absente
 * ou invalide.
 */
export function calculateAge(
  birthday: string | null | undefined,
  now: Date = new Date(),
): number | null {
  if (!birthday) {
    return null;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthday);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  const nowYear = now.getUTCFullYear();
  const nowMonth = now.getUTCMonth() + 1;
  const nowDay = now.getUTCDate();
  const effectiveDay = month === 2 && day === 29 && !isLeapYear(nowYear) ? 28 : day;
  let age = nowYear - year;
  if (nowMonth < month || (nowMonth === month && nowDay < effectiveDay)) {
    age -= 1;
  }
  return age >= 0 ? age : null;
}

/** Date de naissance plausible : vraie date, âge entre MIN_AGE et MAX_AGE. */
export function isPlausibleBirthday(
  birthday: string | null | undefined,
  now: Date = new Date(),
): boolean {
  const age = calculateAge(birthday, now);
  return age !== null && age >= MIN_AGE && age <= MAX_AGE;
}

/** Un compte mineur (< 18 ans) reçoit des défauts de confidentialité stricts. */
export function isMinor(birthday: string | null | undefined, now: Date = new Date()): boolean {
  const age = calculateAge(birthday, now);
  return age !== null && age < 18;
}
