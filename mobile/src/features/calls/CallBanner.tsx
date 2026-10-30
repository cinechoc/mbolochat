import { ChevronUp, MicOff, Phone, X } from 'lucide-react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/avatar';
import { Colors, Motion, Radii, Spacing, Type } from '@/constants/theme';
import { useCalls } from './CallProvider';
import { CallTimer } from './ui/CallTimer';

/**
 * Bandeau flottant d'appel : invitation à rejoindre un appel de groupe ouvert,
 * puis appel réduit. Un seul élément pour les deux états, jamais en même temps
 * que l'écran plein.
 */
export function CallBanner() {
  const {
    status,
    mode,
    peer,
    group,
    peers,
    offer,
    muted,
    startedAt,
    minimized,
    restore,
    joinOffer,
    dismissOffer,
  } = useCalls();
  const insets = useSafeAreaInsets();

  const inCall = status !== 'idle' && status !== 'ended';
  const invited = Boolean(offer) && !inCall;
  if (!invited && !(minimized && inCall)) {
    return null;
  }

  const groupMode = invited ? true : mode === 'GROUP';
  const name = invited
    ? (offer?.name ?? 'Groupe')
    : groupMode
      ? (group?.name ?? 'Appel de groupe')
      : (peer?.displayName ?? 'Contact');
  const connected = peers.filter((entry) => entry.connected).length + 1;
  const timing = inCall && status === 'active' && Boolean(startedAt);
  const subtitle = invited
    ? `${offer?.from.displayName ?? 'Quelqu’un'} appelle`
    : groupMode
      ? `${connected} en ligne`
      : status === 'reconnecting'
        ? 'Reconnexion…'
        : status === 'connecting'
          ? 'Connexion…'
          : 'Appelle…';

  return (
    <View style={[styles.layer, { top: insets.top + Spacing.two }]} pointerEvents="box-none">
      <Animated.View entering={FadeInDown.duration(Motion.base).springify().damping(18)}>
        <Pressable
          onPress={invited ? () => void joinOffer() : restore}
          accessibilityRole="button"
          accessibilityLabel={
            invited ? `Rejoindre l’appel de ${name}` : `Revenir à l’appel avec ${name}`
          }
          style={({ pressed }) => [styles.banner, pressed && styles.pressed]}>
          {groupMode ? (
            <Avatar
              name={name}
              uri={invited ? offer?.avatarUrl : group?.avatarUrl}
              emoji={invited ? offer?.emoji : group?.emoji}
              color={invited ? offer?.color : group?.color}
              variant="group"
              size={34}
            />
          ) : (
            <Avatar name={name} uri={peer?.avatarUrl} size={34} variant="user" />
          )}
          <View style={styles.texts}>
            <Text style={styles.name} numberOfLines={1}>
              {name}
            </Text>
            <View style={styles.statusRow}>
              {muted && !invited ? (
                <MicOff size={11} strokeWidth={2.4} color={Colors.dark.textSecondary} />
              ) : null}
              {timing && !invited ? (
                <CallTimer startedAt={startedAt} active={timing} style={styles.status} />
              ) : (
                <Text style={styles.status} numberOfLines={1}>
                  {subtitle}
                </Text>
              )}
            </View>
          </View>
          {invited ? (
            <>
              <View style={styles.join}>
                <Phone size={14} color={Colors.dark.onAccent} />
                <Text style={styles.joinText}>Rejoindre</Text>
              </View>
              <Pressable
                onPress={dismissOffer}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel="Ignorer l’appel de groupe"
                style={styles.dismiss}>
                <X size={18} color={Colors.dark.textSecondary} />
              </Pressable>
            </>
          ) : (
            <ChevronUp size={20} strokeWidth={2.4} color={Colors.dark.textSecondary} />
          )}
        </Pressable>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  layer: {
    position: 'absolute',
    left: Spacing.threeHalf,
    right: Spacing.threeHalf,
    zIndex: 1000,
    elevation: 12,
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two + 2,
    paddingVertical: Spacing.two,
    paddingLeft: Spacing.two,
    paddingRight: Spacing.threeHalf + 2,
    borderRadius: Radii.pill,
    backgroundColor: Colors.dark.backgroundElevated,
  },
  pressed: { opacity: 0.92, transform: [{ scale: 0.99 }] },
  texts: { flex: 1, minWidth: 0 },
  name: { ...Type.caption, color: Colors.dark.text, fontWeight: '600' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.one },
  status: { ...Type.micro, color: Colors.dark.textSecondary },
  join: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.threeHalf,
    paddingVertical: Spacing.two,
    borderRadius: Radii.pill,
    backgroundColor: Colors.dark.accent,
  },
  joinText: { ...Type.caption, color: Colors.dark.onAccent, fontWeight: '600' },
  dismiss: { padding: Spacing.one },
});
