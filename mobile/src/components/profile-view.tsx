import { type ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { Avatar } from '@/components/avatar';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import type { UserProfile } from '@/lib/types';

interface ProfileHeaderProps {
  profile: UserProfile;
  /** Bouton d'action à droite du pseudo (modifier le profil, envoyer un message…). */
  actions?: ReactNode;
  onPressAvatar?: () => void;
  /** Affiche un voile pendant un changement de photo. */
  avatarBusy?: boolean;
}

/** En-tête de profil façon Instagram : photo à gauche, informations à droite sur la même ligne. */
export function ProfileHeader({
  profile,
  actions,
  onPressAvatar,
  avatarBusy = false,
}: ProfileHeaderProps) {
  return (
    <View style={styles.header}>
      <View style={styles.topRow}>
        <Pressable onPress={onPressAvatar} disabled={!onPressAvatar}>
          <View>
            <Avatar name={profile.displayName} uri={profile.avatarUrl} size={86} />
            {avatarBusy ? (
              <View style={[styles.avatarOverlay, { borderRadius: 43 }]}>
                <ActivityIndicator color="#ffffff" />
              </View>
            ) : null}
          </View>
        </Pressable>

        <View style={styles.topRight}>
          <ThemedText style={styles.username} numberOfLines={1}>
            {profile.username}
          </ThemedText>
          <ThemedText style={styles.displayName} numberOfLines={1}>
            {profile.displayName}
          </ThemedText>
          {profile.bio ? (
            <ThemedText themeColor="textSecondary" style={styles.bio} numberOfLines={3}>
              {profile.bio}
            </ThemedText>
          ) : null}
          {actions ? <View style={styles.actions}>{actions}</View> : null}
        </View>
      </View>
    </View>
  );
}

interface ProfileActionProps {
  label: string;
  onPress: () => void;
  /** Style « plein » (comme le bouton Message d'Instagram). */
  primary?: boolean;
  /** Style « destructif » (bloquer un compte). */
  danger?: boolean;
  loading?: boolean;
}

/** Bouton compact façon Instagram (petit, gris clair, arrondi). */
export function ProfileAction({
  label,
  onPress,
  primary = false,
  danger = false,
  loading = false,
}: ProfileActionProps) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={loading}
      style={({ pressed }) => [
        styles.action,
        {
          backgroundColor: primary ? accentColor : theme.backgroundElement,
          opacity: pressed || loading ? 0.6 : 1,
        },
      ]}>
      {loading ? (
        <ActivityIndicator size="small" color={primary ? '#ffffff' : theme.text} />
      ) : (
        <ThemedText
          style={[
            styles.actionLabel,
            { color: primary ? '#ffffff' : danger ? '#e5484d' : theme.text },
          ]}>
          {label}
        </ThemedText>
      )}
    </Pressable>
  );
}

interface PhotoGridProps {
  photos: { id: string; url: string }[];
}

/**
 * Grille de photos façon Instagram (3 colonnes).
 * La grille est prête à accueillir les médias ; elle reste vide pour l'instant.
 */
export function PhotoGrid({ photos }: PhotoGridProps) {
  const theme = useTheme();

  if (photos.length === 0) {
    return (
      <ThemedView style={[styles.emptyPhotos, { borderColor: theme.backgroundElement }]}>
        <ThemedText type="smallBold" themeColor="textSecondary">
          Aucune photo pour le moment
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary" style={styles.emptyPhotosHint}>
          Les photos partagées dans les discussions apparaîtront ici.
        </ThemedText>
      </ThemedView>
    );
  }

  return (
    <View style={styles.grid}>
      {photos.map((photo) => (
        <ThemedView
          key={photo.id}
          style={[styles.gridItem, { backgroundColor: theme.backgroundElement }]}
        />
      ))}
    </View>
  );
}

const accentColor = '#3c87f7';

const styles = StyleSheet.create({
  header: {
    gap: Spacing.three,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.four,
  },
  topRight: {
    flex: 1,
    gap: Spacing.two,
  },
  username: {
    fontSize: 20,
    fontWeight: '700',
    lineHeight: 26,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  action: {
    minHeight: 34,
    paddingHorizontal: Spacing.three,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionLabel: {
    fontSize: 14,
    fontWeight: '600',
    lineHeight: 18,
  },
  avatarOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  bioBlock: {
    gap: 2,
  },
  displayName: {
    fontSize: 14,
    fontWeight: '700',
    lineHeight: 19,
  },
  bio: {
    fontSize: 14,
    lineHeight: 19,
  },  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 2,
  },
  gridItem: {
    width: '33.33%',
    aspectRatio: 1,
  },
  emptyPhotos: {
    borderWidth: 1,
    borderRadius: 16,
    borderStyle: 'dashed',
    paddingVertical: Spacing.four,
    paddingHorizontal: Spacing.three,
    alignItems: 'center',
    gap: Spacing.one,
  },
  emptyPhotosHint: {
    textAlign: 'center',
  },
});
