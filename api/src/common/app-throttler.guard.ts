import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Le garde-fou de débit est prévu pour HTTP. Appliqué aux messages Socket.IO,
 * il cherche une réponse HTTP inexistante et rejette tous les événements
 * (messages, accusés, présence…). On le cantonne donc au contexte HTTP.
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }
    return super.canActivate(context);
  }
}
