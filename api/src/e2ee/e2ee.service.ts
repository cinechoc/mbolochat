import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { and, eq, isNull, ne, or, sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../db/db.module.js';
import {
  conversationMembers,
  conversations,
  e2eeDevices,
  e2eeOneTimePrekeys,
  refreshTokens,
} from '../db/schema.js';
import type { JwtPayload } from '../auth/jwt-payload.js';

export interface PublicPrekey {
  keyId: string;
  key: string;
}

export interface RegisterDeviceBody {
  identityKey: string;
  signingKey: string;
  signedPrekey?: string;
  signedPrekeySignature?: string;
  oneTimeKeys: PublicPrekey[];
  deviceName?: string;
  platform?: string;
}

export interface KeyBundle {
  deviceId: string;
  identityKey: string;
  signingKey: string;
  signedPrekey: string | null;
  signedPrekeySignature: string | null;
  oneTimeKey: PublicPrekey | null;
}

const MAX_PREKEYS = 100;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function isKey(value: unknown, bytes = 32): value is string {
  if (typeof value !== 'string' || !BASE64.test(value)) return false;
  return Buffer.from(value, 'base64').length === bytes;
}

@Injectable()
export class E2eeService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  assertEnabled(): void {
    const value = process.env.E2EE_ENABLED;
    if (value !== '1' && value?.toLowerCase() !== 'true') {
      throw new NotFoundException('Chiffrement de bout en bout indisponible');
    }
  }

  async status(current: JwtPayload) {
    this.assertEnabled();
    if (!current.deviceId) {
      return { deviceId: null, registered: false };
    }
    const [device] = await this.db
      .select({ id: e2eeDevices.id })
      .from(e2eeDevices)
      .where(
        and(
          eq(e2eeDevices.userId, current.sub),
          eq(e2eeDevices.deviceId, current.deviceId),
          isNull(e2eeDevices.revokedAt),
        ),
      )
      .limit(1);
    return { deviceId: current.deviceId, registered: Boolean(device) };
  }

  async registerDevice(current: JwtPayload, body: RegisterDeviceBody) {
    this.assertEnabled();
    if (!current.deviceId) {
      throw new UnauthorizedException('Appareil non identifié');
    }
    if (!isKey(body.identityKey) || !isKey(body.signingKey)) {
      throw new BadRequestException('Clés publiques invalides');
    }
    if (
      (body.signedPrekey !== undefined && !isKey(body.signedPrekey)) ||
      (body.signedPrekeySignature !== undefined && !isKey(body.signedPrekeySignature, 64))
    ) {
      throw new BadRequestException('Clé signée invalide');
    }
    if (!Array.isArray(body.oneTimeKeys) || body.oneTimeKeys.length > MAX_PREKEYS) {
      throw new BadRequestException('Clés à usage unique invalides');
    }
    for (const prekey of body.oneTimeKeys) {
      if (!isKey(prekey?.key) || typeof prekey.keyId !== 'string' || prekey.keyId.length > 64) {
        throw new BadRequestException('Clé à usage unique invalide');
      }
    }

    const deviceId = current.deviceId;
    const now = new Date();
    const result = await this.db.transaction(async (tx) => {
      const revokedOtherDevices = await tx
        .update(e2eeDevices)
        .set({ revokedAt: now })
        .where(
          and(
            eq(e2eeDevices.userId, current.sub),
            ne(e2eeDevices.deviceId, deviceId),
            isNull(e2eeDevices.revokedAt),
          ),
        )
        .returning({ id: e2eeDevices.id });

      // Un seul appareil actif : les autres sessions ne peuvent plus se rafraîchir.
      await tx
        .update(refreshTokens)
        .set({ revokedAt: now })
        .where(
          and(
            eq(refreshTokens.userId, current.sub),
            isNull(refreshTokens.revokedAt),
            or(isNull(refreshTokens.deviceId), ne(refreshTokens.deviceId, deviceId)),
          ),
        );

      const [existing] = await tx
        .select({ id: e2eeDevices.id })
        .from(e2eeDevices)
        .where(
          and(eq(e2eeDevices.userId, current.sub), eq(e2eeDevices.deviceId, deviceId)),
        )
        .limit(1);

      let deviceRowId: string;
      if (existing) {
        deviceRowId = existing.id;
        await tx
          .update(e2eeDevices)
          .set({
            identityKey: body.identityKey,
            signingKey: body.signingKey,
            signedPrekey: body.signedPrekey ?? null,
            signedPrekeySignature: body.signedPrekeySignature ?? null,
            deviceName: body.deviceName?.slice(0, 80) ?? null,
            platform: body.platform?.slice(0, 40) ?? null,
            lastUsedAt: now,
            revokedAt: null,
          })
          .where(eq(e2eeDevices.id, deviceRowId));
        await tx
          .delete(e2eeOneTimePrekeys)
          .where(
            and(
              eq(e2eeOneTimePrekeys.deviceRowId, deviceRowId),
              isNull(e2eeOneTimePrekeys.usedAt),
            ),
          );
      } else {
        const [created] = await tx
          .insert(e2eeDevices)
          .values({
            userId: current.sub,
            deviceId,
            identityKey: body.identityKey,
            signingKey: body.signingKey,
            signedPrekey: body.signedPrekey ?? null,
            signedPrekeySignature: body.signedPrekeySignature ?? null,
            deviceName: body.deviceName?.slice(0, 80) ?? null,
            platform: body.platform?.slice(0, 40) ?? null,
          })
          .returning({ id: e2eeDevices.id });
        deviceRowId = created.id;
      }

      if (body.oneTimeKeys.length > 0) {
        await tx
          .insert(e2eeOneTimePrekeys)
          .values(
            body.oneTimeKeys.map((prekey) => ({
              deviceRowId,
              keyId: prekey.keyId,
              publicKey: prekey.key,
            })),
          )
          .onConflictDoNothing();
      }

      await this.enableEligibleConversations(tx, current.sub, now);

      return { deviceId, replaced: revokedOtherDevices.length > 0 };
    });

    return result;
  }

  async addPrekeys(current: JwtPayload, prekeys: PublicPrekey[]) {
    this.assertEnabled();
    if (!current.deviceId) throw new UnauthorizedException('Appareil non identifié');
    if (!Array.isArray(prekeys) || prekeys.length === 0 || prekeys.length > MAX_PREKEYS) {
      throw new BadRequestException('Clés à usage unique invalides');
    }
    for (const prekey of prekeys) {
      if (!isKey(prekey?.key) || typeof prekey.keyId !== 'string' || prekey.keyId.length > 64) {
        throw new BadRequestException('Clé à usage unique invalide');
      }
    }
    const [device] = await this.db
      .select({ id: e2eeDevices.id })
      .from(e2eeDevices)
      .where(
        and(
          eq(e2eeDevices.userId, current.sub),
          eq(e2eeDevices.deviceId, current.deviceId),
          isNull(e2eeDevices.revokedAt),
        ),
      )
      .limit(1);
    if (!device) throw new NotFoundException('Appareil inconnu');

    await this.db
      .insert(e2eeOneTimePrekeys)
      .values(
        prekeys.map((prekey) => ({
          deviceRowId: device.id,
          keyId: prekey.keyId,
          publicKey: prekey.key,
        })),
      )
      .onConflictDoNothing();
    return { added: prekeys.length };
  }

  /** Récupère le bundle d'un contact avec qui l'on partage une conversation. */
  async getKeyBundle(current: JwtPayload, targetUserId: string): Promise<KeyBundle> {
    this.assertEnabled();
    const sharedConversation = await this.db.execute<{ one: number }>(sql`
      select 1 as one
      from conversation_members mine
      join conversation_members theirs on theirs.conversation_id = mine.conversation_id
      where mine.user_id = ${current.sub} and theirs.user_id = ${targetUserId}
      limit 1
    `);
    if (sharedConversation.rows.length === 0) {
      throw new ForbiddenException('Aucune conversation commune');
    }

    const [device] = await this.db
      .select()
      .from(e2eeDevices)
      .where(and(eq(e2eeDevices.userId, targetUserId), isNull(e2eeDevices.revokedAt)))
      .limit(1);
    if (!device) throw new NotFoundException('Aucun appareil E2EE actif');

    const oneTimeKey = await this.db.transaction(async (tx) => {
      const [prekey] = await tx
        .select({ id: e2eeOneTimePrekeys.id, keyId: e2eeOneTimePrekeys.keyId, key: e2eeOneTimePrekeys.publicKey })
        .from(e2eeOneTimePrekeys)
        .where(
          and(
            eq(e2eeOneTimePrekeys.deviceRowId, device.id),
            isNull(e2eeOneTimePrekeys.usedAt),
          ),
        )
        .orderBy(e2eeOneTimePrekeys.createdAt)
        .limit(1)
        .for('update', { skipLocked: true });
      if (!prekey) return null;
      await tx
        .update(e2eeOneTimePrekeys)
        .set({ usedAt: new Date() })
        .where(eq(e2eeOneTimePrekeys.id, prekey.id));
      return { keyId: prekey.keyId, key: prekey.key };
    });

    return {
      deviceId: device.deviceId,
      identityKey: device.identityKey,
      signingKey: device.signingKey,
      signedPrekey: device.signedPrekey,
      signedPrekeySignature: device.signedPrekeySignature,
      oneTimeKey,
    };
  }

  async revokeCurrentDevice(current: JwtPayload) {
    this.assertEnabled();
    if (!current.deviceId) throw new UnauthorizedException('Appareil non identifié');
    const now = new Date();
    await this.db
      .update(e2eeDevices)
      .set({ revokedAt: now })
      .where(
        and(
          eq(e2eeDevices.userId, current.sub),
          eq(e2eeDevices.deviceId, current.deviceId),
          isNull(e2eeDevices.revokedAt),
        ),
      );
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: now })
      .where(
        and(
          eq(refreshTokens.userId, current.sub),
          eq(refreshTokens.deviceId, current.deviceId),
          isNull(refreshTokens.revokedAt),
        ),
      );
    return { revoked: true };
  }

  /** Une conversation ne bascule que quand tous ses membres ont un appareil actif. */
  private async enableEligibleConversations(
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    userId: string,
    now: Date,
  ): Promise<void> {
    const candidates = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .innerJoin(
        conversationMembers,
        eq(conversationMembers.conversationId, conversations.id),
      )
      .where(and(eq(conversationMembers.userId, userId), isNull(conversations.e2eeSince)));
    for (const candidate of candidates) {
      const ready = await tx.execute<{ total: number; ready: number }>(sql`
        select count(*)::int as total,
               count(d.id)::int as ready
        from conversation_members cm
        left join e2ee_devices d
          on d.user_id = cm.user_id and d.revoked_at is null
        where cm.conversation_id = ${candidate.id}
      `);
      const counts = ready.rows[0];
      if (counts && counts.total > 0 && counts.ready === counts.total) {
        await tx
          .update(conversations)
          .set({ e2eeSince: now, updatedAt: now })
          .where(eq(conversations.id, candidate.id));
      }
    }
  }
}
