import {
  Inject,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { and, eq, inArray, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { Subject } from 'rxjs';
import { DRIZZLE, type Database } from '../db/db.module.js';
import { blocks, conversationMembers, users } from '../db/schema.js';
import { canSeePresence } from './presence-visibility.js';
import type {
  PresenceEntry,
  PresenceSettings,
  PresenceSnapshot,
  PresenceUser,
} from './presence.types.js';

const HEARTBEAT_TIMEOUT_MS = 60_000;
const DISCONNECT_GRACE_MS = 10_000;
const SWEEP_INTERVAL_MS = 10_000;
const MAX_TARGETS = 50;

interface DevicePresence {
  online: boolean;
  lastHeartbeat: number;
  graceTimer: NodeJS.Timeout | null;
}

export interface PresenceChange {
  userId: string;
  /** Le changement vient des réglages : il faut aussi recalculer la vue de l'utilisateur. */
  settings?: boolean;
}

/**
 * Présence en mémoire, pour une instance unique.
 *
 * Un appareil est identifié par son socket. Un utilisateur est en ligne dès
 * qu'un de ses appareils au premier plan a un battement récent. La base n'est
 * écrite qu'aux transitions en ligne → hors ligne.
 */
@Injectable()
export class PresenceService implements OnModuleInit, OnModuleDestroy {
  private readonly devices = new Map<string, Map<string, DevicePresence>>();
  private readonly changesSubject = new Subject<PresenceChange>();
  readonly changes$ = this.changesSubject.asObservable();
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  onModuleInit(): void {
    this.sweepTimer = setInterval(() => {
      void this.sweepStaleDevices();
    }, SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  /**
   * Arrêt propre de l'API. Appelé avant le nettoyage des modules : les
   * utilisateurs encore en ligne reçoivent leur dernière connexion avant que
   * la mémoire et les timers ne disparaissent.
   */
  async onModuleDestroy(): Promise<void> {
    const onlineUserIds = [...this.devices.entries()]
      .filter(([, devices]) => this.hasOnline(devices))
      .map(([userId]) => userId);
    if (onlineUserIds.length > 0) {
      try {
        await this.db
          .update(users)
          .set({ lastSeenAt: new Date() })
          .where(inArray(users.id, onlineUserIds));
      } catch {
        // L'arrêt ne doit pas être bloqué par un dernier échec de la base.
      }
    }

    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const devices of this.devices.values()) {
      for (const device of devices.values()) {
        if (device.graceTimer) clearTimeout(device.graceTimer);
      }
    }
    this.devices.clear();
    this.changesSubject.complete();
  }

  isOnline(userId: string): boolean {
    return this.hasOnline(this.devices.get(userId));
  }

  /** Passage au premier plan (ou reconnexion) : l'appareil redevient visible. */
  foreground(userId: string, socketId: string): void {
    const devices = this.devices.get(userId) ?? new Map<string, DevicePresence>();
    this.devices.set(userId, devices);
    const wasOnline = this.hasOnline(devices);
    const existing = devices.get(socketId);
    if (existing?.graceTimer) {
      clearTimeout(existing.graceTimer);
    }
    devices.set(socketId, {
      online: true,
      lastHeartbeat: Date.now(),
      graceTimer: null,
    });
    if (!wasOnline) {
      this.changesSubject.next({ userId });
    }
  }

  /** Battement de cœur : met à jour la mémoire, jamais la base. */
  heartbeat(userId: string, socketId: string): void {
    const devices = this.devices.get(userId);
    const device = devices?.get(socketId);
    if (!device?.online) {
      this.foreground(userId, socketId);
      return;
    }
    if (device.graceTimer) {
      clearTimeout(device.graceTimer);
      device.graceTimer = null;
    }
    device.lastHeartbeat = Date.now();
  }

  /** L'app ou l'appareil passe en arrière-plan. */
  async background(userId: string, socketId: string): Promise<void> {
    const devices = this.devices.get(userId);
    const device = devices?.get(socketId);
    if (!devices || !device) return;
    if (device.graceTimer) clearTimeout(device.graceTimer);
    const wasOnline = device.online;
    devices.delete(socketId);
    if (!this.hasOnline(devices)) {
      this.devices.delete(userId);
      await this.markOffline(userId, wasOnline);
    } else if (devices.size === 0) {
      this.devices.delete(userId);
    }
  }

  /**
   * Socket perdu : on garde l'utilisateur en ligne pendant 10 s pour qu'une
   * reconnexion rapide ne fasse pas clignoter son statut.
   */
  disconnect(userId: string, socketId: string): void {
    const devices = this.devices.get(userId);
    const device = devices?.get(socketId);
    if (!devices || !device?.online || device.graceTimer) return;

    const timer = setTimeout(() => {
      const currentDevices = this.devices.get(userId);
      const current = currentDevices?.get(socketId);
      if (!currentDevices || !current || current.graceTimer !== timer) return;
      current.graceTimer = null;
      currentDevices.delete(socketId);
      if (!this.hasOnline(currentDevices)) {
        this.devices.delete(userId);
        void this.markOffline(userId, true).catch(() => undefined);
      } else if (currentDevices.size === 0) {
        this.devices.delete(userId);
      }
    }, DISCONNECT_GRACE_MS);
    timer.unref?.();
    device.graceTimer = timer;
  }

  /** Déconnexion de compte sur cet appareil : tout de suite hors ligne. */
  async logout(userId: string, socketId: string): Promise<void> {
    const devices = this.devices.get(userId);
    const device = devices?.get(socketId);
    if (!devices || !device) return;
    if (device.graceTimer) clearTimeout(device.graceTimer);
    const wasOnline = device.online;
    devices.delete(socketId);
    if (!this.hasOnline(devices)) {
      this.devices.delete(userId);
      await this.markOffline(userId, wasOnline);
    } else if (devices.size === 0) {
      this.devices.delete(userId);
    }
  }

  async getSettings(userId: string): Promise<PresenceSettings> {
    const [row] = await this.db
      .select({
        lastSeenVisibility: users.lastSeenVisibility,
        onlineVisibility: users.onlineVisibility,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!row) throw new NotFoundException('User not found');
    return row;
  }

  async updateSettings(
    userId: string,
    patch: Partial<PresenceSettings>,
  ): Promise<PresenceSettings> {
    const changes: Partial<typeof users.$inferInsert> = {};
    if (patch.lastSeenVisibility !== undefined) {
      changes.lastSeenVisibility = patch.lastSeenVisibility;
    }
    if (patch.onlineVisibility !== undefined) {
      changes.onlineVisibility = patch.onlineVisibility;
    }
    if (Object.keys(changes).length === 0) {
      return this.getSettings(userId);
    }
    const [row] = await this.db
      .update(users)
      .set(changes)
      .where(eq(users.id, userId))
      .returning({
        lastSeenVisibility: users.lastSeenVisibility,
        onlineVisibility: users.onlineVisibility,
      });
    if (!row) throw new NotFoundException('User not found');
    this.changesSubject.next({ userId, settings: true });
    return row;
  }

  /**
   * Seul chemin de lecture pour les clients : chaque champ est ajouté après
   * décision de canSeePresence, jamais filtré ensuite côté mobile.
   */
  async getPresenceForViewer(
    viewerId: string,
    targetIds: string[],
  ): Promise<PresenceSnapshot> {
    const ids = [...new Set(targetIds)].slice(0, MAX_TARGETS);
    const serverNow = new Date().toISOString();
    if (ids.length === 0) {
      return { serverNow, presence: [] };
    }

    const [viewerRow] = await this.db
      .select({
        id: users.id,
        lastSeenVisibility: users.lastSeenVisibility,
        onlineVisibility: users.onlineVisibility,
      })
      .from(users)
      .where(eq(users.id, viewerId))
      .limit(1);
    if (!viewerRow) throw new NotFoundException('User not found');

    const targetRows = await this.db
      .select({
        id: users.id,
        lastSeenAt: users.lastSeenAt,
        lastSeenVisibility: users.lastSeenVisibility,
        onlineVisibility: users.onlineVisibility,
      })
      .from(users)
      .where(inArray(users.id, ids));

    const blockRows = await this.db
      .select({ blockerId: blocks.blockerId, blockedId: blocks.blockedId })
      .from(blocks)
      .where(
        or(
          and(eq(blocks.blockerId, viewerId), inArray(blocks.blockedId, ids)),
          and(inArray(blocks.blockerId, ids), eq(blocks.blockedId, viewerId)),
        ),
      );
    const blocked = new Set<string>();
    for (const row of blockRows) {
      if (row.blockerId === viewerId) blocked.add(row.blockedId);
      else if (row.blockedId === viewerId) blocked.add(row.blockerId);
    }

    const memberA = alias(conversationMembers, 'presence_member_a');
    const memberB = alias(conversationMembers, 'presence_member_b');
    const contactRows = await this.db
      .selectDistinct({ userId: memberB.userId })
      .from(memberA)
      .innerJoin(memberB, eq(memberB.conversationId, memberA.conversationId))
      .where(and(eq(memberA.userId, viewerId), inArray(memberB.userId, ids)));
    const contacts = new Set(contactRows.map((row) => row.userId));

    const byId = new Map(targetRows.map((row) => [row.id, row]));
    const viewer: PresenceUser = viewerRow;
    const presence: PresenceEntry[] = ids.map((id) => {
      const target = byId.get(id);
      if (!target) return { userId: id };
      const permissions = canSeePresence(viewer, target, {
        isContact: contacts.has(id),
        blocked: blocked.has(id),
      });
      const entry: PresenceEntry = { userId: id };
      if (permissions.canSeeOnline) {
        entry.online = this.isOnline(id);
      }
      if (permissions.canSeeLastSeen) {
        entry.lastSeenAt = target.lastSeenAt ? target.lastSeenAt.toISOString() : null;
      }
      return entry;
    });

    return { serverNow, presence };
  }

  private hasOnline(devices: Map<string, DevicePresence> | undefined): boolean {
    if (!devices) return false;
    for (const device of devices.values()) {
      if (device.online) return true;
    }
    return false;
  }

  private async markOffline(userId: string, wasOnline: boolean): Promise<void> {
    if (!wasOnline) return;
    if (this.hasOnline(this.devices.get(userId))) return;
    try {
      await this.db.update(users).set({ lastSeenAt: new Date() }).where(eq(users.id, userId));
    } catch {
      // La prochaine transition réessaiera ; l'état mémoire reste cohérent.
      return;
    }
    this.changesSubject.next({ userId });
  }

  private async sweepStaleDevices(): Promise<void> {
    const now = Date.now();
    // Supprimer d'une Map pendant son itération est sûr et évite une copie.
    for (const [userId, devices] of this.devices) {
      let lostOnline = false;
      for (const [socketId, device] of devices) {
        if (!device.online) {
          devices.delete(socketId);
          continue;
        }
        if (now - device.lastHeartbeat <= HEARTBEAT_TIMEOUT_MS) continue;
        if (device.graceTimer) clearTimeout(device.graceTimer);
        devices.delete(socketId);
        lostOnline = true;
      }
      if (!this.hasOnline(devices)) {
        this.devices.delete(userId);
        await this.markOffline(userId, lostOnline);
      } else if (devices.size === 0) {
        this.devices.delete(userId);
      }
    }
  }
}
