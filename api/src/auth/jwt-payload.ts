export interface JwtPayload {
  sub: string;
  username: string;
  /** Appareil de la session (un seul actif en E2EE). */
  deviceId?: string;
  type?: 'access';
}
