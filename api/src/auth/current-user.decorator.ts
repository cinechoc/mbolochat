import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthenticatedRequest } from './jwt-auth.guard.js';
import type { JwtPayload } from './jwt-payload.js';

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): JwtPayload => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    return request.user;
  },
);
