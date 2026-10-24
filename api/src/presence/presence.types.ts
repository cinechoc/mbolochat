export type LastSeenVisibility = 'everyone' | 'contacts' | 'nobody';
export type OnlineVisibility = 'everyone' | 'same_as_last_seen';

export interface PresenceSettings {
  lastSeenVisibility: LastSeenVisibility;
  onlineVisibility: OnlineVisibility;
}

export interface PresenceUser extends PresenceSettings {
  id: string;
}

export interface PresenceRelation {
  isContact: boolean;
  blocked: boolean;
}

export interface PresencePermissions {
  canSeeOnline: boolean;
  canSeeLastSeen: boolean;
}

/** Une entrée diffusée : un champ absent signifie « non autorisé ». */
export interface PresenceEntry {
  userId: string;
  online?: boolean;
  lastSeenAt?: string | null;
}

export interface PresenceSnapshot {
  serverNow: string;
  presence: PresenceEntry[];
}
