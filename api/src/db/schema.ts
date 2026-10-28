import {
  boolean,
  date,
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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const conversations = pgTable('conversations', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  type: conversationTypeEnum('type').notNull(),
  name: text('name'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('uploads_user_idx').on(table.userId)],
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
    /** Texte Unicode normal, ou sticker référencé par son catalogue local. */
    type: text('type').notNull().default('text'),
    /** Référence de catalogue d'un sticker (« pack/sticker »), null sinon. */
    stickerRef: text('sticker_ref'),
    /** Pièce jointe (photo, vidéo…), null pour un message texte. */
    attachment: jsonb('attachment').$type<MessageAttachment>(),
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
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('refresh_tokens_user_idx').on(table.userId)],
);

export type User = typeof users.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type MessageReceipt = typeof messageReceipts.$inferSelect;
export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;
export type RefreshToken = typeof refreshTokens.$inferSelect;
export type PushToken = typeof pushTokens.$inferSelect;
export type Upload = typeof uploads.$inferSelect;
