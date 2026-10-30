import * as Clipboard from 'expo-clipboard';
import * as Linking from 'expo-linking';
import { useState } from 'react';
import { Pressable, ScrollView, Share, StyleSheet, Switch, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

import { BottomSheet } from '@/components/bottom-sheet';
import { ThemedText } from '@/components/themed-text';
import { Button, accentColor } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import type { GroupInvite } from '@/lib/types';

const EXPIRY_OPTIONS = [
  { label: '1 h', value: 1 },
  { label: '24 h', value: 24 },
  { label: '7 jours', value: 168 },
  { label: '30 jours', value: 720 },
];

const USES_OPTIONS = [
  { label: 'Illimité', value: undefined },
  { label: '1', value: 1 },
  { label: '5', value: 5 },
  { label: '10', value: 10 },
  { label: '25', value: 25 },
];

interface InviteSheetProps {
  conversationId: string | null;
  groupName: string;
  onClose: () => void;
}

/** Création et partage d'un lien d'invitation à un groupe. */
export function InviteSheet({ conversationId, groupName, onClose }: InviteSheetProps) {
  const { token } = useAuth();
  const theme = useTheme();
  const [expiresInHours, setExpiresInHours] = useState(168);
  const [maxUses, setMaxUses] = useState<number | undefined>(undefined);
  const [requiresApproval, setRequiresApproval] = useState(false);
  const [invite, setInvite] = useState<GroupInvite | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const link = invite ? Linking.createURL(`/invite/${invite.token}`) : '';

  const createInvite = async () => {
    if (!token || !conversationId) return;
    setLoading(true);
    setError(null);
    try {
      const created = await api.createInvite(token, conversationId, {
        expiresInHours,
        maxUses,
        requiresApproval,
      });
      setInvite(created);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Impossible de créer le lien.');
    } finally {
      setLoading(false);
    }
  };

  const copy = async () => {
    await Clipboard.setStringAsync(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const share = async () => {
    try {
      await Share.share({
        message: `Rejoins « ${groupName} » sur MboloChat : ${link}`,
      });
    } catch {
      // Partage annulé : rien à signaler.
    }
  };

  return (
    <BottomSheet
      visible
      onClose={onClose}
      title="Inviter dans le groupe"
      subtitle="Toute personne ayant le lien pourra demander à rejoindre."
      maxHeightRatio={0.9}>
      <ScrollView
        style={styles.body}
        contentContainerStyle={styles.bodyContent}
        keyboardShouldPersistTaps="handled">
            {invite ? (
              <>
                <View style={styles.qrWrap}>
                  <QRCode value={link} size={168} backgroundColor="#ffffff" color="#0B1428" />
                </View>
                <ThemedText type="small" numberOfLines={2} style={styles.link}>
                  {link}
                </ThemedText>
                <ThemedText type="small" themeColor="textSecondary">
                  {invite.maxUses === null
                    ? 'Usages illimités'
                    : `${Math.max(0, invite.maxUses - invite.uses)} utilisation(s) restante(s)`}
                  {' · '}
                  {invite.requiresApproval ? 'approbation admin' : 'entrée directe'}
                </ThemedText>
                <Button title={copied ? 'Lien copié' : 'Copier le lien'} onPress={copy} />
                <Button title="Partager" variant="secondary" onPress={share} />
                <Button
                  title="Créer un autre lien"
                  variant="secondary"
                  onPress={() => setInvite(null)}
                />
              </>
            ) : (
              <>
                <ThemedText type="small" themeColor="textSecondary">
                  Durée de validité
                </ThemedText>
                <View style={styles.chipRow}>
                  {EXPIRY_OPTIONS.map((option) => (
                    <Chip
                      key={option.value}
                      label={option.label}
                      active={expiresInHours === option.value}
                      onPress={() => setExpiresInHours(option.value)}
                    />
                  ))}
                </View>

                <ThemedText type="small" themeColor="textSecondary">
                  Nombre d’utilisations
                </ThemedText>
                <View style={styles.chipRow}>
                  {USES_OPTIONS.map((option) => (
                    <Chip
                      key={option.label}
                      label={option.label}
                      active={maxUses === option.value}
                      onPress={() => setMaxUses(option.value)}
                    />
                  ))}
                </View>

                <View style={styles.switchRow}>
                  <View style={styles.switchLabel}>
                    <ThemedText>Les admins approuvent</ThemedText>
                    <ThemedText type="small" themeColor="textSecondary">
                      Chaque demande attend une validation.
                    </ThemedText>
                  </View>
                  <Switch
                    value={requiresApproval}
                    onValueChange={setRequiresApproval}
                    trackColor={{ true: accentColor, false: theme.backgroundSelected }}
                  />
                </View>

                {error ? (
                  <ThemedText type="small" style={{ color: theme.error }}>
                    {error}
                  </ThemedText>
                ) : null}

                <Button title="Créer le lien" onPress={createInvite} loading={loading} />
              </>
            )}
          </ScrollView>
    </BottomSheet>
  );
}

function Chip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.chip,
        { backgroundColor: active ? accentColor : theme.backgroundElement },
      ]}>
      <ThemedText type="small" style={active ? styles.chipTextActive : undefined}>
        {label}
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    justifyContent: 'center',
    paddingHorizontal: Spacing.four,
  },
  card: {
    maxHeight: '85%',
    borderRadius: Spacing.four,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  header: {
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.three,
    paddingBottom: Spacing.two,
    gap: Spacing.half,
  },
  body: { flexGrow: 0 },
  bodyContent: { padding: Spacing.three, gap: Spacing.two },
  qrWrap: { alignItems: 'center', paddingVertical: Spacing.two },
  link: { textAlign: 'center' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.one },
  chip: {
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
    borderRadius: 999,
  },
  chipTextActive: { color: '#ffffff', fontWeight: '600' },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
    paddingVertical: Spacing.one,
  },
  switchLabel: { flex: 1, gap: Spacing.half },
  close: {
    alignItems: 'center',
    paddingVertical: Spacing.three,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
