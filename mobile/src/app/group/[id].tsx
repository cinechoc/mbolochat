import * as ImagePicker from 'expo-image-picker';
import { Redirect, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import {
  Bell,
  BellOff,
  Camera,
  Check,
  ChevronRight,
  Crown,
  EyeOff,
  FileText,
  Link2,
  LogOut,
  Pencil,
  Search,
  Shield,
  ShieldOff,
  UserMinus,
  UserPlus,
  X,
} from 'lucide-react-native';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { ActionSheet, type SheetAction } from '@/components/action-sheet';
import { Avatar } from '@/components/avatar';
import { BottomSheet } from '@/components/bottom-sheet';
import { ContactPicker } from '@/components/contact-picker';
import { EmojiColorPicker } from '@/components/emoji-color-picker';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button, TextField } from '@/components/ui';
import { Gutter, PressScale, Radii, Spacing } from '@/constants/theme';
import { useBottomInset } from '@/hooks/use-bottom-inset';
import { InviteSheet } from '@/features/groups/InviteSheet';
import { useTheme } from '@/hooks/use-theme';
import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { cache } from '@/lib/cache';
import { conversationTitle } from '@/lib/format';
import { connectSocket } from '@/lib/socket';
import type {
  ConversationRemovedEvent,
  ConversationSummary,
  GroupUpdatedEvent,
  JoinRequest,
  MemberInfo,
  MembersChangedEvent,
  User,
} from '@/lib/types';

const MAX_MEMBERS = 100;

export default function GroupScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { token, user } = useAuth();
  const theme = useTheme();
  const router = useRouter();
  const bottomInset = useBottomInset();

  const [conversation, setConversation] = useState<ConversationSummary | null>(() =>
    id ? cache.getConversation(id) : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [joinRequests, setJoinRequests] = useState<JoinRequest[]>([]);
  const [memberTarget, setMemberTarget] = useState<MemberInfo | null>(null);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const [pendingMembers, setPendingMembers] = useState<User[]>([]);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editEmoji, setEditEmoji] = useState('💬');
  const [editColor, setEditColor] = useState('#3c87f7');
  const [previewUri, setPreviewUri] = useState<string | null>(null);
  const [removePhoto, setRemovePhoto] = useState(false);

  const isAdmin = conversation?.myRole === 'admin';
  const me = conversation?.members.find((member) => member.id === user?.id) ?? null;
  const owner = conversation?.members.find((member) => member.id === conversation.ownerId) ?? null;
  const title = conversation ? conversationTitle(conversation, user?.id ?? '') : 'Groupe';

  const applySummary = useCallback((updated: ConversationSummary) => {
    setConversation(updated);
    cache.setConversation(updated);
    setEditName(updated.name ?? '');
    setEditDescription(updated.description ?? '');
    setEditEmoji(updated.emoji ?? '💬');
    setEditColor(updated.color ?? '#3c87f7');
    setPreviewUri(null);
    setRemovePhoto(false);
  }, []);

  const load = useCallback(async () => {
    if (!token || !id) return;
    try {
      const loaded = await api.getConversation(token, id);
      applySummary(loaded);
      if (loaded.myRole === 'admin' && loaded.type === 'GROUP') {
        setJoinRequests(await api.listJoinRequests(token, id));
      } else {
        setJoinRequests([]);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Impossible de charger le groupe.');
    }
  }, [applySummary, token, id]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  useEffect(() => {
    if (!token || !id) return;
    const socket = connectSocket(token);
    const applyGroup = (event: GroupUpdatedEvent) => {
      if (event.conversationId !== id) return;
      setConversation((prev) => {
        if (!prev) return prev;
        const next: ConversationSummary = {
          ...prev,
          name: event.group.name,
          description: event.group.description,
          emoji: event.group.emoji,
          color: event.group.color,
          avatarUrl: event.group.avatarUrl,
          ownerId: event.group.ownerId,
          whoCanSend: event.group.whoCanSend,
          whoCanAdd: event.group.whoCanAdd,
          members: event.members,
          updatedAt: event.group.updatedAt,
        };
        cache.setConversation(next);
        return next;
      });
    };
    const onMembers = (event: MembersChangedEvent) => applyGroup(event);
    const onRemoved = (event: ConversationRemovedEvent) => {
      if (event.conversationId !== id) return;
      cache.removeConversation(id);
      router.replace('/chats');
    };
    socket.on('group:updated', applyGroup);
    socket.on('members:changed', onMembers);
    socket.on('conversation:removed', onRemoved);
    return () => {
      socket.off('group:updated', applyGroup);
      socket.off('members:changed', onMembers);
      socket.off('conversation:removed', onRemoved);
    };
  }, [token, id, router]);

  if (!token || !user) {
    return <Redirect href="/login" />;
  }

  if (conversation && conversation.type === 'DIRECT') {
    return <Redirect href={{ pathname: '/chat/[id]', params: { id: conversation.id } }} />;
  }

  if (!conversation) {
    return (
      <ThemedView style={styles.center}>
        {error ? (
          <ThemedText type="caption" style={{ color: theme.danger }} accessibilityRole="alert">
            {error}
          </ThemedText>
        ) : null}
      </ThemedView>
    );
  }

  const muted = conversation.muted;

  async function changeRole(memberId: string, role: 'admin' | 'member') {
    if (!token || !id) return;
    try {
      applySummary(await api.updateMemberRole(token, id, memberId, role));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Changement de rôle impossible.');
    }
  }

  async function removeMember(memberId: string) {
    if (!token || !id) return;
    try {
      await api.removeConversationMember(token, id, memberId);
      setMemberTarget(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Retrait impossible.');
    }
  }

  async function addMembers(members: User[]) {
    if (!token || !id || members.length === 0) return;
    setAdding(true);
    try {
      applySummary(
        await api.addConversationMembers(
          token,
          id,
          members.map((member) => member.id),
        ),
      );
      setPendingMembers([]);
      setAddOpen(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Ajout impossible.');
    } finally {
      setAdding(false);
    }
  }

  async function savePermissions(patch: {
    whoCanSend?: 'all' | 'admins';
    whoCanAdd?: 'all' | 'admins';
  }) {
    if (!token || !id) return;
    try {
      applySummary(await api.updateGroup(token, id, patch));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Changement de permission impossible.');
    }
  }

  async function saveGroup() {
    if (!token || !id || !conversation) return;
    const current = conversation;
    setSaving(true);
    try {
      let updated: ConversationSummary | null = current;
      const identityChanged =
        editName.trim() !== (current.name ?? '') ||
        editDescription.trim() !== (current.description ?? '') ||
        editEmoji !== (current.emoji ?? '💬') ||
        editColor.toLowerCase() !== (current.color ?? '#3c87f7').toLowerCase();
      if (identityChanged) {
        updated = await api.updateGroup(token, id, {
          name: editName,
          description: editDescription,
          emoji: editEmoji,
          color: editColor,
        });
      }
      if (removePhoto && updated?.avatarUrl) {
        updated = await api.deleteGroupPhoto(token, id);
      }
      if (previewUri) {
        const match = /^data:([^;]+);base64,(.*)$/.exec(previewUri);
        if (match) {
          updated = await api.uploadGroupPhoto(token, id, match[2], match[1]);
        }
      }
      if (updated) {
        applySummary(updated);
      }
      setEditOpen(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Enregistrement impossible.');
    } finally {
      setSaving(false);
    }
  }

  async function pickPhoto() {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setError('Autorise l’accès aux photos pour choisir un avatar.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.7,
      base64: true,
    });
    const asset = result.canceled ? null : result.assets?.[0];
    if (asset?.base64) {
      setPreviewUri(`data:${asset.mimeType ?? 'image/jpeg'};base64,${asset.base64}`);
      setRemovePhoto(false);
    }
  }

  async function leaveGroup() {
    if (!token || !id || !me) return;
    try {
      await api.removeConversationMember(token, id, me.id);
      cache.removeConversation(id);
      router.replace('/chats');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Impossible de quitter le groupe.');
    }
  }

  async function resolveRequest(requestId: string, action: 'approve' | 'reject') {
    if (!token || !id) return;
    try {
      await api.resolveJoinRequest(token, id, requestId, action);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Action impossible.');
    }
  }

  const toggleMute = () => {
    if (!token || !id) return;
    void api
      .setConversationPreferences(token, id, { muted: !muted })
      .then((updated) => applySummary(updated))
      .catch((err: unknown) =>
        setError(err instanceof ApiError ? err.message : 'Action impossible.'),
      );
  };

  const hideConversation = () => {
    if (!token || !id) return;
    void api
      .setConversationPreferences(token, id, { hidden: true })
      .then(() => {
        cache.removeConversation(id);
        router.replace('/chats');
      })
      .catch((err: unknown) =>
        setError(err instanceof ApiError ? err.message : 'Action impossible.'),
      );
  };

  const memberActions: SheetAction[] = [];
  if (memberTarget && conversation) {
    const isOwner = memberTarget.id === conversation.ownerId;
    const isMe = memberTarget.id === user.id;
    memberActions.push({
      key: 'profile',
      label: 'Voir le profil',
      onPress: () => {
        const target = memberTarget;
        setMemberTarget(null);
        router.push({
          pathname: '/user/[id]',
          params: {
            id: target.id,
            name: target.displayName,
            username: target.username,
            avatar: target.avatarUrl ?? '',
            gender: target.gender ?? '',
          },
        });
      },
    });
    if (isAdmin && !isMe && !isOwner) {
      memberActions.push({
        key: 'role',
        label: memberTarget.role === 'admin' ? 'Retirer le rôle admin' : 'Nommer administrateur',
        icon: memberTarget.role === 'admin' ? ShieldOff : Shield,
        onPress: () => {
          const target = memberTarget;
          setMemberTarget(null);
          void changeRole(target.id, target.role === 'admin' ? 'member' : 'admin');
        },
      });
    }
    if (isAdmin && !isMe) {
      memberActions.push({
        key: 'remove',
        label: 'Retirer du groupe',
        icon: UserMinus,
        destructive: true,
        onPress: () => {
          const target = memberTarget;
          setMemberTarget(null);
          void removeMember(target.id);
        },
      });
    }
  }

  const full = conversation.members.length >= MAX_MEMBERS;
  const dirty =
    editName.trim() !== (conversation.name ?? '') ||
    editDescription.trim() !== (conversation.description ?? '') ||
    editEmoji !== (conversation.emoji ?? '💬') ||
    editColor.toLowerCase() !== (conversation.color ?? '#3c87f7').toLowerCase() ||
    previewUri !== null ||
    (removePhoto && Boolean(conversation.avatarUrl));

  return (
    <ThemedView style={styles.container}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: bottomInset + Spacing.five }]}
        showsVerticalScrollIndicator={false}>
        {error ? (
          <ThemedText type="caption" style={{ color: theme.danger }} accessibilityRole="alert">
            {error}
          </ThemedText>
        ) : null}

        <View style={styles.hero}>
          <Pressable
            onPress={() => (isAdmin ? setEditOpen(true) : undefined)}
            disabled={!isAdmin}
            accessibilityRole={isAdmin ? 'button' : 'image'}
            accessibilityLabel={isAdmin ? 'Modifier la photo du groupe' : 'Avatar du groupe'}
            style={({ pressed }) => [
              pressed && isAdmin && { transform: [{ scale: PressScale }] },
            ]}>
            <Avatar
              name={title}
              uri={conversation.avatarUrl}
              emoji={conversation.emoji}
              color={conversation.color}
              variant="group"
              size={104}
            />
            {isAdmin ? (
              <View style={[styles.cameraBadge, { backgroundColor: theme.accent }]}>
                <Camera size={15} color={theme.onAccent} />
              </View>
            ) : null}
          </Pressable>
          <ThemedText type="screenTitle" style={styles.title}>
            {title}
          </ThemedText>
          {conversation.description ? (
            <ThemedText type="caption" themeColor="textSecondary" style={styles.description}>
              {conversation.description}
            </ThemedText>
          ) : null}
          <ThemedText type="caption" themeColor="textSecondary">
            {conversation.members.length} membre{conversation.members.length > 1 ? 's' : ''}
            {owner ? ` · créé par ${owner.displayName}` : ''}
          </ThemedText>
        </View>

        <View style={styles.quickRow}>
          <QuickAction
            icon={Search}
            label="Rechercher"
            onPress={() =>
              router.push({ pathname: '/conversation-search/[id]', params: { id: id ?? '' } })
            }
          />
          <QuickAction
            icon={UserPlus}
            label="Ajouter"
            onPress={() => setAddOpen(true)}
            disabled={full}
          />
          <QuickAction icon={Link2} label="Inviter" onPress={() => setInviteOpen(true)} />
          <QuickAction
            icon={muted ? BellOff : Bell}
            label={muted ? 'Muet' : 'Notifs'}
            onPress={toggleMute}
          />
        </View>

        {isAdmin && joinRequests.length > 0 ? (
          <Card title={`Demandes d’adhésion (${joinRequests.length})`}>
            {joinRequests.map((request) => (
              <View key={request.id} style={styles.row}>
                <Avatar
                  name={request.user.displayName}
                  uri={request.user.avatarUrl}
                  gender={request.user.gender}
                  size={40}
                />
                <View style={styles.rowBody}>
                  <ThemedText numberOfLines={1}>{request.user.displayName}</ThemedText>
                  <ThemedText type="caption" themeColor="textSecondary">
                    @{request.user.username}
                  </ThemedText>
                </View>
                <Pressable
                  onPress={() => void resolveRequest(request.id, 'approve')}
                  hitSlop={10}
                  accessibilityRole="button"
                  accessibilityLabel="Approuver">
                  <Check size={22} color={theme.accent} />
                </Pressable>
                <Pressable
                  onPress={() => void resolveRequest(request.id, 'reject')}
                  hitSlop={10}
                  accessibilityRole="button"
                  accessibilityLabel="Refuser">
                  <X size={22} color={theme.textSecondary} />
                </Pressable>
              </View>
            ))}
          </Card>
        ) : null}

        <Card title={`Membres (${conversation.members.length})`}>
          {conversation.members.map((member) => {
            const isOwner = member.id === conversation.ownerId;
            return (
              <Pressable
                key={member.id}
                onPress={() => setMemberTarget(member)}
                accessibilityRole="button"
                accessibilityLabel={`${member.displayName}, ${isOwner ? 'propriétaire' : member.role}`}
                style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}>
                <Avatar
                  name={member.displayName}
                  uri={member.avatarUrl}
                  gender={member.gender}
                  size={44}
                />
                <View style={styles.rowBody}>
                  <View style={styles.nameRow}>
                    <ThemedText numberOfLines={1} style={styles.rowTitle}>
                      {member.displayName}
                      {member.id === user.id ? ' (toi)' : ''}
                    </ThemedText>
                    {isOwner ? <Crown size={14} color={theme.accent} /> : null}
                  </View>
                  <ThemedText type="caption" themeColor="textSecondary" numberOfLines={1}>
                    {isOwner
                      ? `Propriétaire · @${member.username}`
                      : member.role === 'admin'
                        ? `Admin · @${member.username}`
                        : `@${member.username}`}
                  </ThemedText>
                </View>
                <ChevronRight size={18} color={theme.textSecondary} />
              </Pressable>
            );
          })}
        </Card>

        <Card title="Paramètres du groupe">
          {isAdmin ? (
            <SettingRow icon={Pencil} label="Modifier le groupe" onPress={() => setEditOpen(true)} />
          ) : null}
          {isAdmin ? (
            <SettingRow
              icon={Shield}
              label="Permissions"
              onPress={() => setPermissionsOpen(true)}
            />
          ) : null}
          <SettingRow
            icon={FileText}
            label="Médias, liens et documents"
            onPress={() =>
              router.push({ pathname: '/conversation-search/[id]', params: { id: id ?? '' } })
            }
          />
          <SettingRow icon={EyeOff} label="Masquer la conversation" onPress={hideConversation} />
        </Card>

        <Pressable
          onPress={() => setLeaveOpen(true)}
          accessibilityRole="button"
          accessibilityLabel="Quitter le groupe"
          style={({ pressed }) => [
            styles.dangerRow,
            { borderColor: theme.border },
            pressed && { opacity: 0.7 },
          ]}>
          <LogOut size={20} color={theme.danger} />
          <ThemedText style={{ color: theme.danger, fontWeight: '600' }}>
            Quitter le groupe
          </ThemedText>
        </Pressable>
      </ScrollView>

      <ActionSheet
        visible={memberTarget !== null}
        title={memberTarget?.displayName}
        actions={memberActions}
        onClose={() => setMemberTarget(null)}
      />

      <ActionSheet
        visible={leaveOpen}
        title="Quitter le groupe ?"
        subtitle="Tu ne recevras plus les messages de cette discussion."
        actions={[
          {
            key: 'leave',
            label: 'Quitter le groupe',
            icon: LogOut,
            destructive: true,
            onPress: () => {
              setLeaveOpen(false);
              void leaveGroup();
            },
          },
        ]}
        onClose={() => setLeaveOpen(false)}
      />

      {inviteOpen ? (
        <InviteSheet
          conversationId={id ?? null}
          groupName={title}
          onClose={() => setInviteOpen(false)}
        />
      ) : null}

      {addOpen ? (
        <BottomSheet
          visible
          onClose={() => {
            setAddOpen(false);
            setPendingMembers([]);
          }}
          title="Ajouter des membres"
          subtitle={`${conversation.members.length} / ${MAX_MEMBERS} membres`}
          fill
          footer={
            <Button
              title={`Ajouter${pendingMembers.length > 1 ? ` (${pendingMembers.length})` : ''}`}
              onPress={() => void addMembers(pendingMembers)}
              loading={adding}
              disabled={pendingMembers.length === 0}
            />
          }>
          <ContactPicker
            selected={pendingMembers}
            onToggle={(candidate) =>
              setPendingMembers((previous) =>
                previous.some((entry) => entry.id === candidate.id)
                  ? previous.filter((entry) => entry.id !== candidate.id)
                  : [...previous, candidate],
              )
            }
            excludeIds={conversation.members.map((member) => member.id)}
            max={MAX_MEMBERS - conversation.members.length}
          />
        </BottomSheet>
      ) : null}

      <BottomSheet
        visible={permissionsOpen}
        onClose={() => setPermissionsOpen(false)}
        title="Permissions du groupe"
        subtitle="Qui peut écrire et inviter dans ce groupe.">
        <View style={styles.permissionsSheet}>
          <PermissionRow
            label="Qui peut écrire"
            value={conversation.whoCanSend}
            onChange={(value) => void savePermissions({ whoCanSend: value })}
          />
          <PermissionRow
            label="Qui peut ajouter des membres"
            value={conversation.whoCanAdd}
            onChange={(value) => void savePermissions({ whoCanAdd: value })}
          />
        </View>
      </BottomSheet>

      <BottomSheet
        visible={editOpen}
        onClose={() => {
          setEditOpen(false);
          setPreviewUri(null);
          setRemovePhoto(false);
        }}
        title="Modifier le groupe"
        maxHeightRatio={0.92}
        footer={
          <Button
            title="Enregistrer"
            onPress={() => void saveGroup()}
            loading={saving}
            disabled={!dirty}
          />
        }>
        <ScrollView contentContainerStyle={styles.editSheet} keyboardShouldPersistTaps="handled">
          <View style={styles.editAvatar}>
            <Avatar
              name={title}
              uri={previewUri ?? (removePhoto ? null : conversation.avatarUrl)}
              emoji={editEmoji}
              color={editColor}
              variant="group"
              size={96}
            />
            <View style={styles.photoActions}>
              <Pressable onPress={() => void pickPhoto()} accessibilityRole="button">
                <ThemedText type="caption" style={{ color: theme.accent }}>
                  Changer la photo
                </ThemedText>
              </Pressable>
              {(conversation.avatarUrl || previewUri) && !removePhoto ? (
                <Pressable
                  onPress={() => {
                    setPreviewUri(null);
                    setRemovePhoto(true);
                  }}
                  accessibilityRole="button">
                  <ThemedText type="caption" style={{ color: theme.danger }}>
                    Supprimer la photo
                  </ThemedText>
                </Pressable>
              ) : null}
            </View>
          </View>

          <View style={styles.field}>
            <ThemedText type="sectionTitle">Nom</ThemedText>
            <TextField
              value={editName}
              onChangeText={setEditName}
              maxLength={50}
              placeholder="Nom du groupe"
              accessibilityLabel="Nom du groupe"
            />
            <ThemedText type="micro" themeColor="textSecondary" style={styles.counter}>
              {editName.length} / 50
            </ThemedText>
          </View>

          <View style={styles.field}>
            <ThemedText type="sectionTitle">Description</ThemedText>
            <TextField
              value={editDescription}
              onChangeText={setEditDescription}
              maxLength={200}
              multiline
              placeholder="À quoi sert ce groupe ?"
              accessibilityLabel="Description du groupe"
            />
            <ThemedText type="micro" themeColor="textSecondary" style={styles.counter}>
              {editDescription.length} / 200
            </ThemedText>
          </View>

          <EmojiColorPicker
            emoji={editEmoji}
            color={editColor}
            onChangeEmoji={setEditEmoji}
            onChangeColor={setEditColor}
          />

        </ScrollView>
      </BottomSheet>
    </ThemedView>
  );
}

function PermissionRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: 'all' | 'admins';
  onChange: (value: 'all' | 'admins') => void;
}) {
  const theme = useTheme();
  return (
    <View style={styles.permissionRow}>
      <ThemedText>{label}</ThemedText>
      <View style={styles.permissionChoices}>
        {(
          [
            { key: 'all', label: 'Tout le monde' },
            { key: 'admins', label: 'Admins' },
          ] as const
        ).map((option) => {
          const active = value === option.key;
          return (
            <Pressable
              key={option.key}
              onPress={() => onChange(option.key)}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={`${label} : ${option.label}`}
              style={[
                styles.permissionChip,
                {
                  backgroundColor: active ? theme.accent : theme.backgroundElement,
                  borderColor: active ? theme.accent : theme.border,
                },
              ]}>
              <ThemedText
                type="caption"
                style={active ? { color: theme.onAccent, fontWeight: '600' } : undefined}>
                {option.label}
              </ThemedText>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  const theme = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: theme.backgroundElement }]}>
      <ThemedText type="sectionTitle" style={styles.cardTitle}>
        {title}
      </ThemedText>
      {children}
    </View>
  );
}

function QuickAction({
  icon: Icon,
  label,
  onPress,
  disabled,
}: {
  icon: typeof Bell;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.quickAction,
        { backgroundColor: theme.backgroundElement },
        pressed && { transform: [{ scale: PressScale }] },
        disabled && { opacity: 0.4 },
      ]}>
      <Icon size={22} color={theme.text} />
      <ThemedText type="caption">{label}</ThemedText>
    </Pressable>
  );
}

function SettingRow({
  icon: Icon,
  label,
  onPress,
}: {
  icon: typeof Bell;
  label: string;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}>
      <Icon size={20} color={theme.text} />
      <ThemedText style={styles.rowBody}>{label}</ThemedText>
      <ChevronRight size={18} color={theme.textSecondary} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.four },
  content: { padding: Gutter, gap: Spacing.three },
  hero: { alignItems: 'center', gap: Spacing.half, paddingTop: Spacing.two },
  title: { textAlign: 'center', marginTop: Spacing.one },
  description: { textAlign: 'center', paddingHorizontal: Spacing.three },
  cameraBadge: {
    position: 'absolute',
    right: 0,
    bottom: 2,
    width: 30,
    height: 30,
    borderRadius: Radii.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  quickRow: { flexDirection: 'row', gap: Spacing.two, justifyContent: 'center' },
  quickAction: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.one,
    minHeight: 64,
    borderRadius: Radii.md,
  },
  card: {
    borderRadius: Radii.md,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  cardTitle: { paddingVertical: Spacing.one },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.threeHalf,
    minHeight: 56,
    paddingVertical: Spacing.one,
  },
  rowBody: { flex: 1, gap: 1 },
  rowTitle: { fontWeight: '600' },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.one },
  dangerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    marginTop: Spacing.two,
    minHeight: 52,
    borderRadius: Radii.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  permissionsSheet: { paddingHorizontal: Gutter, paddingBottom: Spacing.four, gap: Spacing.three },
  permissionRow: { gap: Spacing.two },
  permissionChoices: { flexDirection: 'row', gap: Spacing.two },
  permissionChip: {
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: Radii.sm,
    borderWidth: StyleSheet.hairlineWidth,
    minHeight: 40,
    justifyContent: 'center',
  },
  editSheet: {
    paddingHorizontal: Gutter,
    paddingBottom: Spacing.four,
    gap: Spacing.three,
  },
  editAvatar: { alignItems: 'center', gap: Spacing.two },
  photoActions: { flexDirection: 'row', gap: Spacing.four },
  field: { gap: Spacing.two },
  counter: { alignSelf: 'flex-end' },
});
