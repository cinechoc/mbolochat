import * as ImagePicker from 'expo-image-picker';
import { Redirect, useRouter } from 'expo-router';
import { ArrowLeft, Camera } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import Animated, { FadeIn, FadeOut, SlideInRight, SlideOutLeft } from 'react-native-reanimated';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/avatar';
import { ContactPicker } from '@/components/contact-picker';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button, TextField } from '@/components/ui';
import { Gutter, PressScale, Radii, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import type { User } from '@/lib/types';

const MAX_MEMBERS = 100;

function defaultGroupName(members: User[]): string {
  const names = members.map((member) => member.displayName.split(' ')[0]);
  if (names.length === 0) return 'Nouveau groupe';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} et ${names[1]}`;
  const others = names.length - 2;
  return `${names[0]}, ${names[1]} et ${others} autre${others > 1 ? 's' : ''}`;
}

/**
 * Création d'un groupe en deux étapes courtes : les membres, puis le nom.
 * Emoji, couleur, description et photo d'un groupe existant se règlent plus
 * tard dans ses informations — on ne demande ici que l'essentiel.
 */
export default function NewGroupScreen() {
  const { token } = useAuth();
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [step, setStep] = useState<'members' | 'name'>('members');
  const [selected, setSelected] = useState<User[]>([]);
  const [name, setName] = useState('');
  const [photo, setPhoto] = useState<{ base64: string; mimeType: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const suggestion = useMemo(() => defaultGroupName(selected), [selected]);
  const finalName = name.trim() || suggestion;

  if (!token) {
    return <Redirect href="/login" />;
  }

  const toggle = (user: User) => {
    setSelected((previous) => {
      if (previous.some((entry) => entry.id === user.id)) {
        return previous.filter((entry) => entry.id !== user.id);
      }
      if (previous.length + 1 >= MAX_MEMBERS) {
        setError('Un groupe est limité à 100 membres.');
        return previous;
      }
      setError(null);
      return [...previous, user];
    });
  };

  const pickPhoto = async () => {
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
      setPhoto({ base64: asset.base64, mimeType: asset.mimeType ?? 'image/jpeg' });
      setError(null);
    }
  };

  const create = async () => {
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      const conversation = await api.createConversation(token, {
        type: 'GROUP',
        name: finalName,
        emoji: '💬',
        color: theme.accent,
        memberIds: selected.map((member) => member.id),
      });
      if (photo) {
        // La photo est un supplément : son échec ne doit pas annuler le groupe.
        try {
          await api.uploadGroupPhoto(token, conversation.id, photo.base64, photo.mimeType);
        } catch {
          // Ignoré volontairement.
        }
      }
      router.replace({ pathname: '/chat/[id]', params: { id: conversation.id } });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Impossible de créer le groupe.');
      setCreating(false);
    }
  };

  const goBack = () => {
    if (step === 'name') {
      setStep('members');
      return;
    }
    router.back();
  };

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.flex} edges={['top', 'left', 'right', 'bottom']}>
        <View style={styles.header}>
          <Pressable
            onPress={goBack}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Retour"
            style={({ pressed }) => pressed && { opacity: 0.6 }}>
            <ArrowLeft size={24} color={theme.text} />
          </Pressable>
          <View style={styles.headerBody}>
            <ThemedText type="screenTitle">
              {step === 'members' ? 'Nouveau groupe' : 'Nommer le groupe'}
            </ThemedText>
            <ThemedText type="caption" themeColor="textSecondary">
              {step === 'members'
                ? `${selected.length + 1} / ${MAX_MEMBERS} membres`
                : 'Tu pourras tout changer plus tard.'}
            </ThemedText>
          </View>
        </View>

        {error ? (
          <ThemedText type="caption" style={[styles.error, { color: theme.danger }]} accessibilityRole="alert">
            {error}
          </ThemedText>
        ) : null}

        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          {step === 'members' ? (
            <Animated.View entering={FadeIn.duration(180)} exiting={SlideOutLeft.duration(200)} style={styles.flex}>
              <ContactPicker
                selected={selected}
                onToggle={toggle}
                max={MAX_MEMBERS - 1}
                placeholder="Rechercher un pseudo ou un nom"
              />
            </Animated.View>
          ) : (
            <Animated.View entering={SlideInRight.duration(220)} exiting={FadeOut.duration(150)} style={styles.flex}>
              <ScrollView
                style={styles.flex}
                contentContainerStyle={styles.nameStep}
                keyboardShouldPersistTaps="handled">
              <View style={styles.avatarRow}>
                <Pressable
                  onPress={() => void pickPhoto()}
                  accessibilityRole="button"
                  accessibilityLabel="Choisir une photo de groupe"
                  style={({ pressed }) => [
                    pressed && { transform: [{ scale: PressScale }] },
                  ]}>
                  <Avatar
                    name={finalName}
                    uri={photo ? `data:${photo.mimeType};base64,${photo.base64}` : null}
                    emoji="💬"
                    color={theme.accent}
                    variant="group"
                    size={96}
                  />
                  <View style={[styles.cameraBadge, { backgroundColor: theme.accent }]}>
                    <Camera size={16} color={theme.onAccent} />
                  </View>
                </Pressable>
                <ThemedText type="caption" themeColor="textSecondary">
                  Photo optionnelle
                </ThemedText>
              </View>

              <View style={styles.field}>
                <ThemedText type="sectionTitle">Nom du groupe</ThemedText>
                <TextField
                  value={name}
                  onChangeText={setName}
                  maxLength={50}
                  placeholder={suggestion}
                  returnKeyType="done"
                  accessibilityLabel="Nom du groupe"
                />
                <ThemedText type="micro" themeColor="textSecondary" style={styles.counter}>
                  {name.length} / 50
                </ThemedText>
              </View>

              <View style={styles.field}>
                <ThemedText type="sectionTitle">Membres ({selected.length + 1})</ThemedText>
                <View style={styles.memberList}>
                  {selected.map((member) => (
                    <View key={member.id} style={styles.memberRow}>
                      <Avatar
                        name={member.displayName}
                        uri={member.avatarUrl}
                        gender={member.gender}
                        size={32}
                      />
                      <ThemedText type="body" numberOfLines={1} style={styles.memberName}>
                        {member.displayName}
                      </ThemedText>
                    </View>
                  ))}
                  <View style={styles.memberRow}>
                    <Avatar name="Toi" size={32} />
                    <ThemedText type="body" themeColor="textSecondary">
                      Toi
                    </ThemedText>
                  </View>
                </View>
              </View>
              </ScrollView>
            </Animated.View>
          )}

          <View
            style={[
              styles.footer,
              {
                borderTopColor: theme.border,
                paddingBottom: Math.max(insets.bottom, Spacing.threeHalf),
              },
            ]}>
            {step === 'members' ? (
              <View style={styles.footerButton}>
                <Button
                  title="Suivant"
                  onPress={() => setStep('name')}
                  disabled={selected.length === 0}
                />
              </View>
            ) : (
              <View style={styles.footerButton}>
                <Button title="Créer le groupe" onPress={() => void create()} loading={creating} />
              </View>
            )}
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.threeHalf,
    paddingHorizontal: Gutter,
    paddingTop: Spacing.two,
    paddingBottom: Spacing.threeHalf,
  },
  headerBody: { flex: 1, gap: 1 },
  error: { paddingHorizontal: Gutter, paddingBottom: Spacing.one },
  nameStep: {
    paddingHorizontal: Gutter,
    gap: Spacing.four,
    paddingTop: Spacing.two,
    paddingBottom: Spacing.five,
  },
  avatarRow: { alignItems: 'center', gap: Spacing.two },
  cameraBadge: {
    position: 'absolute',
    right: -2,
    bottom: 4,
    width: 30,
    height: 30,
    borderRadius: Radii.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  field: { gap: Spacing.two },
  counter: { alignSelf: 'flex-end' },
  memberList: { gap: Spacing.two },
  memberRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two, minHeight: 44 },
  memberName: { flex: 1 },
  footer: {
    marginTop: 'auto',
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Gutter,
    paddingVertical: Spacing.threeHalf,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  footerButton: { flex: 1 },
});
