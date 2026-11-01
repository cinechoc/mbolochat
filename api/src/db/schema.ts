import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  doublePrecision,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const conversationTypeEnum = pgEnum('conversation_type', ['DIRECT', 'GROUP']);

export const lastSeenVisibilityEnum = pgEnum('last_seen_visibility', [
  'everyone',
  'contacts',
  'nobody',
]);
export const onlineVisibilityEnum = pgEnum('online_visibility', [
  'everyone',
  'same_as_last_seen',
]);

/** Qui peut voir / faire quoi : tout le monde, mes contacts, personne. */
export const privacyVisibilityEnum = pgEnum('privacy_visibility', [
  'everyone',
  'contacts',
  'nobody',
]);

export const users = pgTable('users', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  email: text('email').notNull().unique(),
  username: text('username').notNull().unique(),
  displayName: text('display_name').notNull(),
  bio: text('bio'),
  /** Notifications dans l'application (badges, compteurs de non-lus). */
  notificationsEnabled: boolean('notifications_enabled').notNull().default(true),
  /** Son des notifications poussées (les appels sonnent toujours). */
  notificationSound: boolean('notification_sound').notNull().default(true),
  /** Aperçu du texte des messages dans les notifications. */
  notificationPreview: boolean('notification_preview').notNull().default(true),
  passwordHash: text('password_hash').notNull(),
  avatarUrl: text('avatar_url'),
  birthday: date('birthday'),
  gender: text('gender'),
  /** Dernier passage en ligne → hors ligne, en UTC. */
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  lastSeenVisibility: lastSeenVisibilityEnum('last_seen_visibility')
    .notNull()
    .default('contacts'),
  onlineVisibility: onlineVisibilityEnum('online_visibility')
    .notNull()
    .default('same_as_last_seen'),
  /** Ville vérifiée par géocodage serveur : jamais de coordonnées stockées. */
  city: text('city'),
  country: text('country'),
  cityUpdatedAt: timestamp('city_updated_at', { withTimezone: true }),
  /** La ville est masquée aux autres par défaut pour les mineurs. */
  cityVisible: boolean('city_visible').notNull().default(true),
  /** Photo, bio, ville et âge : même visibilité pour ces quatre champs. */
  profileVisibility: privacyVisibilityEnum('profile_visibility').notNull().default('everyone'),
  /** Qui peut m'écrire (nouvelle conversation directe). */
  writePermission: privacyVisibilityEnum('write_permission').notNull().default('everyone'),
  /** Qui peut m'ajouter à un groupe. */
  groupAddPermission: privacyVisibilityEnum('group_add_permission').notNull().default('everyone'),
  /** Qui peut m'appeler. */
  callPermission: privacyVisibilityEnum('call_permission').notNull().default('everyone'),
  /** Qui peut me trouver par nom d'utilisateur. */
  discoverability: privacyVisibilityEnum('discoverability').notNull().default('everyone'),
  /** Accusés de lecture diffusés aux autres (la lecture locale reste vraie). */
  readReceipts: boolean('read_receipts').notNull().default(true),
  /** Indicateur « en train d'écrire » diffusé aux autres. */
  typingIndicator: boolean('typing_indicator').notNull().default(true),
  notifyMessages: boolean('notify_messages').notNull().default(true),
  notifyGroups: boolean('notify_groups').notNull().default(true),
  notifyMentions: boolean('notify_mentions').notNull().default(true),
  notifyCalls: boolean('notify_calls').notNull().default(true),
  notifyReactions: boolean('notify_reactions').notNull().default(true),
  quietHoursEnabled: boolean('quiet_hours_enabled').notNull().default(false),
  /** Minutes depuis minuit, heure locale du compte. */
  quietStartMinute: integer('quiet_start_minute').notNull().default(1320),
  quietEndMinute: integer('quiet_end_minute').notNull().default(420),
  quietUtcOffsetMinutes: integer('quiet_utc_offset_minutes').notNull().default(0),
  /** Suppression demandée : anonymisation après 30 jours, annulable avant. */
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const conversations = pgTable('conversations', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  type: conversationTypeEnum('type').notNull(),
  name: text('name'),
  /** Photo du groupe (même stockage que les avatars utilisateurs). */
  avatarUrl: text('avatar_url'),
  /** Identité de repli quand il n'y a pas de photo. */
  emoji: text('emoji'),
  color: text('color'),
  description: text('description'),
  /** Créateur du groupe : badge « propriétaire », non révocable par les autres. */
  ownerId: text('owner_id').references(() => users.id, { onDelete: 'set null' }),
  /** Qui peut écrire : `all` (défaut) ou `admins`. */
  sendPermission: text('send_permission').notNull().default('all'),
  /** Qui peut ajouter des membres : `all` (défaut) ou `admins`. */
  addPermission: text('add_permission').notNull().default('all'),
  /** Bascule irréversible vers le chiffrement de bout en bout. */
  e2eeSince: timestamp('e2ee_since', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const conversationRoleEnum = pgEnum('conversation_role', ['admin', 'member']);

export const conversationMembers = pgTable(
  'conversation_members',
  {
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    lastReadAt: timestamp('last_read_at', { withTimezone: true }),
    pinnedAt: timestamp('pinned_at', { withTimezone: true }),
    mutedAt: timestamp('muted_at', { withTimezone: true }),
    /** Discussion masquée : elle n'apparaît plus dans la liste. */
    hidden: boolean('hidden').notNull().default(false),
    /**
     * Qui pilote le groupe. Sans rôle, le premier arrivé pouvait renommer la
     * discussion de tout le monde et en expulser n'importe qui.
     */
    role: conversationRoleEnum('role').notNull().default('member'),
  },
  (table) => [primaryKey({ columns: [table.conversationId, table.userId] })],
);

/**
 * Lien d'invitation à rejoindre un groupe. Le jeton est la seule chose que
 * porte le lien partagé : il ne permet rien d'autre que de demander l'entrée.
 */
export const conversationInvites = pgTable(
  'conversation_invites',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    createdById: text('created_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** `null` = illimité. */
    maxUses: integer('max_uses'),
    uses: integer('uses').notNull().default(0),
    /** L'admin doit approuver chaque demande avant l'entrée. */
    requiresApproval: boolean('requires_approval').notNull().default(false),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('conversation_invites_conversation_idx').on(table.conversationId)],
);

export const joinRequestStatusEnum = pgEnum('join_request_status', [
  'pending',
  'approved',
  'rejected',
]);

/** Demande d'entrée déposée via un lien d'invitation. */
export const conversationJoinRequests = pgTable(
  'conversation_join_requests',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    inviteId: text('invite_id')
      .notNull()
      .references(() => conversationInvites.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: joinRequestStatusEnum('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedById: text('resolved_by_id').references(() => users.id, { onDelete: 'set null' }),
  },
  (table) => [
    uniqueIndex('conversation_join_requests_invite_user_idx').on(
      table.inviteId,
      table.userId,
    ),
    index('conversation_join_requests_conversation_status_idx').on(
      table.conversationId,
      table.status,
    ),
  ],
);

/** Comptes bloqués par un utilisateur. */
export const blocks = pgTable(
  'blocks',
  {
    blockerId: text('blocker_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    blockedId: text('blocked_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.blockerId, table.blockedId] })],
);

/**
 * Jetons de notification push (Expo Push Service) par appareil.
 *
 * La clé est le couple (compte, appareil) — jamais le jeton seul : un jeton est
 * une valeur publique une fois qu'un appareil l'a envoyée quelque part, et un
 * compte ne doit pas pouvoir la rattacher à lui pour détourner les alertes d'un
 * autre, ni la supprimer pour les faire taire.
 */
export const pushTokens = pgTable(
  'push_tokens',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: text('token').notNull(),
    platform: text('platform').notNull().default('android'),
    /** Appareil propriétaire du jeton (JWT), pour le nettoyage ciblé. */
    deviceId: text('device_id'),
    /** Adresse de l'API telle que l'appareil la joint (pour les images). */
    baseUrl: text('base_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('push_tokens_user_idx').on(table.userId),
    uniqueIndex('push_tokens_user_token_idx').on(table.userId, table.token),
  ],
);

export type MessageAttachmentType = 'IMAGE' | 'VIDEO' | 'AUDIO' | 'FILE' | 'GIF' | 'STICKER';

/** Pièce jointe d'un message (photo pour l'instant, extensible). */
export interface MessageAttachment {
  type: MessageAttachmentType;
  /** Chemin relatif servi par l'API (« /uploads/… »), ou URL absolue externe
   *  (GIPHY : `https://media*.giphy.com/…`) chargée directement par l'app. */
  url: string;
  mime: string;
  size: number;
  width?: number;
  height?: number;
  /** Durée d'un message vocal, en millisecondes. */
  duration?: number;
  /** Nom d'origine (fichiers). */
  name?: string;
  /** GIF GIPHY : sticker animé transparent (sinon GIF plein cadre). */
  sticker?: boolean;
  /** Identifiant du GIF côté GIPHY. */
  giphyId?: string;
  /** Compte GIPHY source (attribution). */
  username?: string;
  /** Titre du GIF GIPHY. */
  title?: string;
  /** Aperçu statique (lenteur réseau) — même domaine allowlisté que `url`. */
  stillUrl?: string;
  /** Sticker Mbolo : identifiant stable dans le catalogue local. */
  stickerId?: string;
  /** Pack d'origine du sticker (local, personnel, futur pack téléchargé). */
  stickerPackId?: string;
  /** Nom accessible du sticker, affiché par les lecteurs d'écran. */
  stickerName?: string;
}

/**
 * Pièce jointe chiffrée de bout en bout : une **référence** vers un fichier
 * opaque. Le serveur ne connaît que l'existence du blob et de quel droit on peut
 * le lire ; ni URL, ni clé, ni nonce, ni empreinte, ni nature. Le contenu et sa
 * description (type, nom, dimensions) vivent exclusivement dans l'enveloppe Olm,
 * que le serveur ne lit jamais.
 *
 * Le champ `url` est délibérément absent : `MediaUrlInterceptor` ne réécrit que
 * les chaînes « /uploads/… », donc une référence chiffrée lui échappe — voulu.
 */
export interface E2eeAttachmentRef {
  /** Identifiant de l'upload chiffré, servi par `GET /uploads/:id`. */
  uploadId: string;
}

/** Fichier importé par un utilisateur, avant (ou après) son envoi. */
export const uploads = pgTable(
  'uploads',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    /** Nom d'origine du fichier, affiché pour les documents. */
    name: text('name'),
    width: integer('width'),
    height: integer('height'),
    /** Durée d'un vocal ou d'une vidéo importée, en millisecondes. */
    durationMs: integer('duration_ms'),
    /**
     * true pour un fichier chiffré de bout en bout : le serveur ne sait pas le
     * décoder, ne le sert que par `GET /uploads/:id` et à un membre de la
     * conversation liée. Ces fichiers ne passent jamais par la route signée des
     * médias en clair.
     */
    encrypted: boolean('encrypted').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('uploads_user_idx').on(table.userId)],
);

/**
 * Lien fichier chiffré ↔ conversation. C'est une **métadonnée** (qui a le droit
 * de télécharger), jamais le contenu : le serveur ne peut pas rattacher un
 * ciphertext à sa conversation, alors le client le déclare à l'envoi et le
 * serveur vérifie l'appartenance avant de l'enregistrer.
 */
export const uploadConversations = pgTable(
  'upload_conversations',
  {
    uploadId: text('upload_id')
      .primaryKey()
      .references(() => uploads.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('upload_conversations_conversation_idx').on(table.conversationId)],
);

export const messages = pgTable(
  'messages',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    senderId: text('sender_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    /** `none` (historique en clair) ou `v1` (enveloppe chiffrée opaque). */
    encryption: text('encryption').notNull().default('none'),
    /** Enveloppe chiffrée base64 ; le serveur ne la déchiffre jamais. */
    payload: text('payload'),
    /** `prekey` pour le premier message d'une session, `normal` ensuite. */
    payloadType: text('payload_type'),
    /** Appareil émetteur (JWT) pour rattacher l'enveloppe à ses clés. */
    senderDeviceId: text('sender_device_id'),
    /** Texte Unicode normal, ou sticker référencé par son catalogue local. */
    type: text('type').notNull().default('text'),
    /** Référence de catalogue d'un sticker (« pack/sticker »), null sinon. */
    stickerRef: text('sticker_ref'),
    /** Pièce jointe (photo, vidéo…), null pour un message texte. */
    attachment: jsonb('attachment').$type<MessageAttachment>(),
    /**
     * Référence d'une pièce jointe chiffrée : le ciphertext, dont la clé voyage
     * dans `payload`. Alternative de `attachment` : un message n'a jamais les
     * deux. Aucune URL ici, donc rien que l'intercepteur de médias puisse signer.
     */
    encryptedAttachment: jsonb('encrypted_attachment').$type<E2eeAttachmentRef>(),
    /**
     * Identifiant d'envoi généré par l'appareil émetteur. Une reprise après
     * une coupure renvoie le même message au lieu d'en créer un doublon.
     */
    clientId: text('client_id'),
    /**
     * Message cité par une « réponse ». Un lien et non une copie : la citation
     * suit le fil, et l'original garde sa place.
     */
    replyToId: text('reply_to_id'),
    /**
     * Supprimé pour tous. Le contenu et la pièce jointe sont effacés avec cette
     * date ; sans elle, un message vide ressemblerait à un message supprimé.
     */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('messages_conversation_created_idx').on(table.conversationId, table.createdAt),
    uniqueIndex('messages_sender_client_idx').on(table.senderId, table.clientId),
  ],
);

/**
 * Accusés de réception, par membre et par message : ce que l'appareil du
 * destinataire a effectivement reçu (`delivered_at`) et ce qu'il a lu
 * (`read_at`). C'est ce qui distingue la coche « envoyée », « reçue » et « lue ».
 */
export const messageReceipts = pgTable(
  'message_receipts',
  {
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    readAt: timestamp('read_at', { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.messageId, table.userId] }),
    index('message_receipts_user_idx').on(table.userId),
  ],
);

/** Réactions emoji : une par membre et par emoji sur un message. */
export const messageReactions = pgTable(
  'message_reactions',
  {
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Référence de sticker (« mbolo-panther-2d/amour »). La colonne garde son
     *  ancien nom SQL `emoji` : aucun changement de schéma n'est nécessaire. */
    reaction: text('emoji').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.messageId, table.userId, table.reaction] }),
    index('message_reactions_message_idx').on(table.messageId),
  ],
);

/**
 * Messages retirés de la vue d'un seul membre (« supprimer pour moi »). La ligne
 * reste en base : les autres membres continuent de la lire. C'est une liste
 * d'interdits par compte, pas une suppression.
 */
export const messageHides = pgTable(
  'message_hides',
  {
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.messageId, table.userId] }),
    index('message_hides_user_idx').on(table.userId),
  ],
);

export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    attempts: integer('attempts').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('password_reset_tokens_user_idx').on(table.userId)],
);

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    /** Appareil lisible (« Samsung Galaxy A54 · Android 14 ») pour la liste des sessions. */
    deviceName: text('device_name'),
    platform: text('platform'),
    /** Identifiant d'appareil porté par le JWT (appareil unique actif). */
    deviceId: text('device_id'),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('refresh_tokens_user_idx').on(table.userId)],
);

/**
 * Cache du géocodage inverse : une cellule arrondie (jamais la position
 * exacte d'un utilisateur) donne le nom de la ville et le pays. Les
 * coordonnées ne servent qu'au calcul de distance (anti-téléport) et ne sont
 * rattachées à aucun compte.
 */
export const geoCityCache = pgTable('geo_city_cache', {
  cell: text('cell').primaryKey(),
  city: text('city').notNull(),
  country: text('country'),
  latitude: doublePrecision('latitude').notNull(),
  longitude: doublePrecision('longitude').notNull(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Appareil E2EE actif : seules les clés publiques sont stockées. */
export const e2eeDevices = pgTable(
  'e2ee_devices',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Identifiant d'appareil issu du JWT, stable entre les refresh tokens. */
    deviceId: text('device_id').notNull(),
    identityKey: text('identity_key').notNull(),
    signingKey: text('signing_key').notNull(),
    signedPrekey: text('signed_prekey'),
    signedPrekeySignature: text('signed_prekey_signature'),
    /** Clé de secours signée, utilisée quand la réserve est épuisée. */
    fallbackPrekey: text('fallback_prekey'),
    fallbackPrekeySignature: text('fallback_prekey_signature'),
    fallbackPrekeyKeyId: text('fallback_prekey_key_id'),
    deviceName: text('device_name'),
    platform: text('platform'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('e2ee_devices_user_device_idx').on(table.userId, table.deviceId),
    uniqueIndex('e2ee_devices_active_user_idx')
      .on(table.userId)
      .where(sql`${table.revokedAt} is null`),
  ],
);

/** Clés publiques à usage unique, consommées à la création d'une session Olm. */
export const e2eeOneTimePrekeys = pgTable(
  'e2ee_one_time_prekeys',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    deviceRowId: text('device_row_id')
      .notNull()
      .references(() => e2eeDevices.id, { onDelete: 'cascade' }),
    keyId: text('key_id').notNull(),
    publicKey: text('public_key').notNull(),
    /** Signature Ed25519 de la clé publique par l'identité de l'appareil. */
    signature: text('signature'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    usedAt: timestamp('used_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('e2ee_prekeys_device_key_idx').on(table.deviceRowId, table.keyId),
    index('e2ee_prekeys_device_used_idx').on(table.deviceRowId, table.usedAt),
  ],
);

export type User = typeof users.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type MessageReceipt = typeof messageReceipts.$inferSelect;
export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;
export type RefreshToken = typeof refreshTokens.$inferSelect;
export type PushToken = typeof pushTokens.$inferSelect;
export type Upload = typeof uploads.$inferSelect;
export type GeoCityCache = typeof geoCityCache.$inferSelect;
