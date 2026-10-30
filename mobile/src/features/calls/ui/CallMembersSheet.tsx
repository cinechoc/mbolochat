import { Check, X } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/avatar';
import { BottomSheet } from '@/components/bottom-sheet';
import { Button } from '@/components/ui';
import { useTheme } from '@/hooks/use-theme';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { Radii, Spacing, Type } from '@/constants/theme';
import type { MemberInfo } from '@/lib/types';
import type { CallParticipant } from '@/lib/calls';

/**
 * Feuille de gestion des participants d'un appel de groupe : rappeler ceux qui
 * ne sont pas venus, et sortir quelqu'un de l'appel pour un administrateur.
 */
export function CallMembersSheet({
  visible,
  onClose,
  conversationId,
  participants,
  onInvite,
  onKick,
}: {
  visible: boolean;
  onClose: () => void;
  conversationId: string | null;
  participants: CallParticipant[];
  onInvite: (userIds: string[]) => void;
  onKick: (userId: string) => void;
}) {
  const theme = useTheme();
  const { token } = useAuth();
  const [members, setMembers] = useState<MemberInfo[]>([]);
  const [admin, setAdmin] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);

  useEffect(() => {
    if (!visible || !conversationId || !token) {
      return;
    }
    let cancelled = false;
    void api
      .getConversation(token, conversationId)
      .then((summary) => {
        if (cancelled) {
          return;
        }
        setMembers(summary.members);
        setAdmin(summary.myRole === 'admin');
        setSelected([]);
      })
      .catch(() => {
        if (!cancelled) {
          setMembers([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId, token, visible]);

  const present = new Set(participants.map((participant) => participant.id));
  const absentees = members.filter((member) => !present.has(member.id));

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title="Participants"
      footer={
        <Button
          title={selected.length > 0 ? `Inviter ${selected.length}` : 'Inviter'}
          disabled={selected.length === 0}
          onPress={() => {
            onInvite(selected);
            onClose();
          }}
        />
      }>
      <ScrollView style={styles.list}>
        {participants.length > 0 ? (
          <>
            <Text style={[styles.section, { color: theme.textSecondary }]}>Dans l’appel</Text>
            {participants.map((participant) => (
              <View key={participant.id} style={styles.row}>
                <Avatar name={participant.displayName} uri={participant.avatarUrl} size={36} />
                <Text style={[styles.name, { color: theme.text }]} numberOfLines={1}>
                  {participant.displayName}
                </Text>
                {admin ? (
                  <Pressable
                    onPress={() => {
                      onKick(participant.id);
                      onClose();
                    }}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={`Retirer ${participant.displayName} de l’appel`}
                    style={({ pressed }) => [styles.trailing, pressed && styles.pressed]}>
                    <X size={18} color={theme.danger} />
                  </Pressable>
                ) : null}
              </View>
            ))}
          </>
        ) : null}

        {absentees.length > 0 ? (
          <>
            <Text style={[styles.section, { color: theme.textSecondary }]}>
              Inviter dans l’appel
            </Text>
            {absentees.map((member) => {
              const checked = selected.includes(member.id);
              return (
                <Pressable
                  key={member.id}
                  onPress={() =>
                    setSelected((previous) =>
                      previous.includes(member.id)
                        ? previous.filter((id) => id !== member.id)
                        : [...previous, member.id],
                    )
                  }
                  accessibilityRole="button"
                  accessibilityLabel={`Inviter ${member.displayName}`}
                  style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
                  <Avatar name={member.displayName} uri={member.avatarUrl} size={36} />
                  <Text style={[styles.name, { color: theme.text }]} numberOfLines={1}>
                    {member.displayName}
                  </Text>
                  <View
                    style={[
                      styles.check,
                      { borderColor: checked ? theme.accent : theme.border },
                      checked && { backgroundColor: theme.accent },
                    ]}>
                    {checked ? <Check size={14} color={theme.onAccent} /> : null}
                  </View>
                </Pressable>
              );
            })}
          </>
        ) : null}
      </ScrollView>

    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  list: { maxHeight: 360 },
  section: { ...Type.micro, marginBottom: Spacing.two, textTransform: 'uppercase' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.threeHalf,
    paddingVertical: Spacing.two,
  },
  name: { ...Type.body, flex: 1, minWidth: 0 },
  trailing: { padding: Spacing.one },
  check: {
    width: 22,
    height: 22,
    borderRadius: Radii.pill,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: 0.85 },
});
