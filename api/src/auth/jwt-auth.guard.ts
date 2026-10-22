import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import type { JwtPayload } from './jwt-payload.js';

export interface AuthenticatedRequest extends Request {
  user: JwtPayload;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (!token) {
      throw new UnauthorizedException('Missing bearer token');
    }
    try {
      const payload = await this.jwtService.verifyAsync<JwtPayload>(token);
      // Un jeton sans type n'est pas un jeton d'accès : sans ce contrôle, un
      // jeton fabriqué pour un autre usage serait accepté ici.
      if (payload.type !== 'access') {
        throw new UnauthorizedException('Invalid token type');
      }
      request.user = payload;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
    return true;
  }
}
