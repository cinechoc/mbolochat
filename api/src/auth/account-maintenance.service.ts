import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { AuthService } from './auth.service.js';

/**
 * Anonymise les comptes dont la suppression date de plus de 30 jours. La
 * vérification est horaire ; le délai exact est appliqué par le service.
 */
@Injectable()
export class AccountMaintenanceService implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly auth: AuthService) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.auth.purgeExpiredDeletions().catch(() => {});
    }, 60 * 60 * 1000);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
