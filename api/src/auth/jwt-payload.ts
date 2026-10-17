export interface JwtPayload {
  sub: string;
  username: string;
  type?: 'access';
}
