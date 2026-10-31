import { createHash, randomBytes, randomInt } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcryptjs';
import { and, desc, eq, gt, isNull, lt } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../db/db.module.js';
import { passwordResetTokens, pushTokens, refreshTokens, users } from '../db/schema.js';
import { toPublicUser, UsersService, type PublicUser } from '../users/users.service.js';
import { isMinor } from '../users/age.js';
import type { ForgotPasswordDto } from './dto/forgot-password.dto.js';
import type { LoginDto } from './dto/login.dto.js';
import type { RegisterDto } from './dto/register.dto.js';
import type { ResetPasswordDto } from './dto/reset-password.dto.js';
import type { JwtPayload } from './jwt-payload.js';

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  user: PublicUser;
}

export interface ForgotPasswordResult {
  message: string;
  devCode?: string;
}

const MINIMUM_AGE = 13;
const RESET_CODE_TTL_MS = 15 * 60 * 1000;
const MAX_RESET_ATTEMPTS = 5;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Suppression différée : annulable en se reconnectant pendant 30 jours. */
export const DELETION_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

export type DeviceInfo = { name?: string | null; platform?: string | null };
const GENERIC_RESET_MESSAGE = 'Si ce compte existe, un code de réinitialisation a été envoyé.';

/**
 * Le code de réinitialisation n'est renvoyé au client (et écrit dans les journaux)
 * qu'en développement ou en test. `NODE_ENV` non défini n'ouvre PAS cette porte :
 * une installation qui oublie de la régler doit être sûre par défaut.
 */
function exposesResetCode(): boolean {
  const env = process.env.NODE_ENV;
  return env === 'development' || env === 'test';
}

function usernamePart(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    @Inject(DRIZZLE) private readonly db: Database,
  ) {}

  async register(dto: RegisterDto, device?: DeviceInfo): Promise<AuthResult> {
    const existing = await this.usersService.findByEmailOrUsername(dto.email);
    if (existing) {
      throw new ConflictException('Cette adresse e-mail est déjà utilisée.');
    }

    const birthday = new Date(dto.birthday);
    if (Number.isNaN(birthday.getTime())) {
      throw new BadRequestException('La date de naissance n’est pas valide.');
    }
    if (this.ageFrom(birthday) < MINIMUM_AGE) {
      throw new BadRequestException(
        `Tu dois avoir au moins ${MINIMUM_AGE} ans pour créer un compte.`,
      );
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);
    const username = await this.generateUsername(dto.firstName, dto.lastName);
    const displayName = `${dto.firstName} ${dto.lastName}`.trim().slice(0, 48);

    const user = await this.usersService.create({
      email: dto.email,
      username,
      displayName,
      passwordHash,
      birthday: dto.birthday,
      gender: dto.gender,
    });
    if (isMinor(dto.birthday)) {
      await this.usersService.applyMinorDefaults(user.id);
    }
    return this.buildAuthResult(user.id, user.username, toPublicUser(user), device);
  }

  async login(dto: LoginDto, device?: DeviceInfo): Promise<AuthResult> {
    const user = await this.usersService.findByEmailOrUsername(dto.emailOrUsername);
    if (!user || !(await bcrypt.compare(dto.password, user.passwordHash))) {
      throw new UnauthorizedException(
        'Email (ou nom d’utilisateur) ou mot de passe incorrect.',
      );
    }
    if (user.deletedAt) {
      if (Date.now() - user.deletedAt.getTime() >= DELETION_GRACE_MS) {
        throw new UnauthorizedException('Ce compte a été supprimé.');
      }
      // Revenir dans les 30 jours annule la suppression.
      await this.db.update(users).set({ deletedAt: null }).where(eq(users.id, user.id));
    }
    return this.buildAuthResult(user.id, user.username, toPublicUser(user), device);
  }

  async forgotPassword(dto: ForgotPasswordDto): Promise<ForgotPasswordResult> {
    const user = await this.usersService.findByEmailOrUsername(dto.emailOrUsername.trim());
    if (!user) {
      return { message: GENERIC_RESET_MESSAGE };
    }

    await this.db.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, user.id));

    const code = randomInt(100000, 1000000).toString();
    await this.db.insert(passwordResetTokens).values({
      userId: user.id,
      codeHash: await this.hashResetCode(code),
      expiresAt: new Date(Date.now() + RESET_CODE_TTL_MS),
    });

    if (!exposesResetCode()) {
      return { message: GENERIC_RESET_MESSAGE };
    }
    // Hors production, le code est écrit et renvoyé : c'est ce qui tient lieu
    // d'envoi de mail tant qu'il n'existe pas.
    this.logger.log(`Code de réinitialisation pour ${user.username} : ${code} (valable 15 min)`);
    return { message: GENERIC_RESET_MESSAGE, devCode: code };
  }

  async resetPassword(dto: ResetPasswordDto): Promise<{ message: string }> {
    const user = await this.usersService.findByEmailOrUsername(dto.emailOrUsername.trim());
    const [token] = user
      ? await this.db
          .select()
          .from(passwordResetTokens)
          .where(eq(passwordResetTokens.userId, user.id))
          .orderBy(desc(passwordResetTokens.createdAt))
          .limit(1)
      : [];

    if (!user || !token || token.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException('Code invalide ou expiré. Demande un nouveau code.');
    }
    if (token.attempts >= MAX_RESET_ATTEMPTS) {
      await this.db.delete(passwordResetTokens).where(eq(passwordResetTokens.id, token.id));
      throw new BadRequestException('Trop de tentatives. Demande un nouveau code.');
    }
    if (!(await bcrypt.compare(dto.code, token.codeHash))) {
      await this.db
        .update(passwordResetTokens)
        .set({ attempts: token.attempts + 1 })
        .where(eq(passwordResetTokens.id, token.id));
      throw new BadRequestException('Code invalide ou expiré. Demande un nouveau code.');
    }

    const passwordHash = await bcrypt.hash(dto.newPassword, 10);
    await this.usersService.updatePassword(user.id, passwordHash);
    await this.db.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, user.id));

    return { message: 'Mot de passe modifié. Tu peux te connecter.' };
  }

  /**
   * Le code n'est qu'un nombre à 6 chiffres : un SHA-256 non salé se teste par
   * force brute en une fraction de seconde sur une base volée. bcrypt rend chaque
   * hypothèse coûteuse, et le sel est porté par l'empreinte elle-même.
   */
  private async hashResetCode(code: string): Promise<string> {
    return bcrypt.hash(code, 10);
  }

  private async generateUsername(firstName: string, lastName: string): Promise<string> {
    let base = `${usernamePart(firstName)}.${usernamePart(lastName)}`.replace(/^\.+|\.+$/g, '');
    if (base.length < 3) {
      base = `${base}${Math.floor(1000 + Math.random() * 9000)}`;
    }
    const candidate = base.slice(0, 20);

    let username = candidate;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (attempt > 0) {
        username = `${candidate.slice(0, 15)}_${Math.floor(1000 + Math.random() * 9000)}`;
      }
      const taken = await this.usersService.findByEmailOrUsername(username);
      if (!taken) {
        return username;
      }
    }
    throw new ConflictException(
      'Impossible de générer un nom d’utilisateur unique. Réessaie.',
    );
  }

  private ageFrom(birthday: Date): number {
    const now = new Date();
    let age = now.getUTCFullYear() - birthday.getUTCFullYear();
    const monthDiff = now.getUTCMonth() - birthday.getUTCMonth();
    if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < birthday.getUTCDate())) {
      age -= 1;
    }
    return age;
  }

  private async buildAuthResult(
    userId: string,
    username: string,
    user: PublicUser,
    device?: DeviceInfo,
  ): Promise<AuthResult> {
    const payload: JwtPayload = { sub: userId, username, type: 'access' };
    const accessToken = await this.jwtService.signAsync(payload);
    const rawRefresh = randomBytes(32).toString('hex');
    const tokenHash = this.hashRefreshToken(rawRefresh);
    await this.db.insert(refreshTokens).values({
      userId,
      tokenHash,
      deviceName: device?.name?.slice(0, 80) || null,
      platform: device?.platform?.slice(0, 40) || null,
      lastUsedAt: new Date(),
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
    });
    return { accessToken, refreshToken: rawRefresh, user };
  }

  async refresh(rawRefreshToken: string): Promise<AuthResult> {
    if (!rawRefreshToken) {
      throw new UnauthorizedException('Missing refresh token');
    }
    const tokenHash = this.hashRefreshToken(rawRefreshToken);
    const [stored] = await this.db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, tokenHash))
      .limit(1);

    if (!stored || stored.revokedAt || stored.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    // rotation : revoke the old one
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(eq(refreshTokens.id, stored.id));

    const user = await this.usersService.getByIdOrThrow(stored.userId);
    const publicUser = toPublicUser(user);
    return this.buildAuthResult(user.id, user.username, publicUser, {
      name: stored.deviceName,
      platform: stored.platform,
    });
  }

  async logout(rawRefreshToken?: string): Promise<void> {
    if (!rawRefreshToken) return;
    const tokenHash = this.hashRefreshToken(rawRefreshToken);
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(eq(refreshTokens.tokenHash, tokenHash));
  }

  /* ------------------------- sessions et compte ------------------------- */

  async listSessions(userId: string) {
    return this.db
      .select({
        id: refreshTokens.id,
        deviceName: refreshTokens.deviceName,
        platform: refreshTokens.platform,
        createdAt: refreshTokens.createdAt,
        lastUsedAt: refreshTokens.lastUsedAt,
        expiresAt: refreshTokens.expiresAt,
      })
      .from(refreshTokens)
      .where(
        and(
          eq(refreshTokens.userId, userId),
          isNull(refreshTokens.revokedAt),
          gt(refreshTokens.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(refreshTokens.lastUsedAt));
  }

  /** Révoque une session précise, uniquement si elle appartient au compte. */
  async revokeSession(userId: string, sessionId: string): Promise<{ revoked: boolean }> {
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.id, sessionId), eq(refreshTokens.userId, userId)));
    return { revoked: true };
  }

  private async revokeAllSessions(userId: string): Promise<void> {
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
  }

  /** Changement de mot de passe : toutes les sessions sont déconnectées. */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ changed: boolean; signedOut: boolean }> {
    if (typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 72) {
      throw new BadRequestException('Le nouveau mot de passe doit faire 8 à 72 caractères.');
    }
    const user = await this.usersService.getByIdOrThrow(userId);
    if (
      typeof currentPassword !== 'string' ||
      !(await bcrypt.compare(currentPassword, user.passwordHash))
    ) {
      throw new UnauthorizedException('Mot de passe actuel incorrect.');
    }
    await this.usersService.updatePassword(user.id, await bcrypt.hash(newPassword, 10));
    await this.revokeAllSessions(user.id);
    return { changed: true, signedOut: true };
  }

  /** Demande de suppression : déconnecte tout, anonymise après 30 jours. */
  async requestAccountDeletion(
    userId: string,
    password: string,
  ): Promise<{ scheduled: true; deleteAt: Date }> {
    const user = await this.usersService.getByIdOrThrow(userId);
    if (typeof password !== 'string' || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new UnauthorizedException('Mot de passe incorrect.');
    }
    const deletedAt = new Date();
    await this.db.update(users).set({ deletedAt }).where(eq(users.id, user.id));
    await this.revokeAllSessions(user.id);
    return { scheduled: true, deleteAt: new Date(deletedAt.getTime() + DELETION_GRACE_MS) };
  }

  /** Anonymisation des comptes dont le délai de 30 jours est écoulé. */
  async purgeExpiredDeletions(now: Date = new Date()): Promise<number> {
    const threshold = new Date(now.getTime() - DELETION_GRACE_MS);
    const expired = await this.db
      .select({ id: users.id })
      .from(users)
      .where(and(lt(users.deletedAt, threshold)));
    for (const row of expired) {
      const suffix = row.id.replace(/-/g, '').slice(0, 12);
      await this.db
        .update(users)
        .set({
          email: `deleted_${row.id}@deleted.invalid`,
          username: `deleted_${suffix}`,
          displayName: 'Compte supprimé',
          bio: null,
          avatarUrl: null,
          gender: null,
          birthday: null,
          city: null,
          country: null,
          cityUpdatedAt: null,
          cityVisible: false,
          passwordHash: await bcrypt.hash(randomBytes(24).toString('hex'), 10),
          notificationsEnabled: false,
          notificationSound: false,
          notificationPreview: false,
        })
        .where(eq(users.id, row.id));
      await this.db.delete(pushTokens).where(eq(pushTokens.userId, row.id));
    }
    return expired.length;
  }

  private hashRefreshToken(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }
}
