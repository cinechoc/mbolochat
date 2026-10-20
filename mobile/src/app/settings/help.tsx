import { Redirect, Stack } from 'expo-router';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useAuth } from '@/lib/auth-context';

const FAQ: { question: string; answer: string }[] = [
  {
    question: 'Comment masquer une discussion ?',
    answer:
      'Ouvre la discussion, appuie sur « Infos » (groupes) ou appuie long sur la discussion puis choisis « Masquer la discussion ». Elle reste accessible depuis Paramètres › Confidentialité › Conversations masquées.',
  },
  {
    question: 'Comment couper les notifications ?',
    answer:
      'Paramètres › Notifications : tu peux désactiver globalement les pastilles de non-lus, ou couper le son de chaque discussion individuellement.',
  },
  {
    question: 'Comment bloquer quelqu’un ?',
    answer:
      'Ouvre le profil de la personne puis appuie sur « Bloquer ». Elle ne pourra plus t’envoyer de messages. Pour annuler : Paramètres › Confidentialité › Comptes bloqués.',
  },
  {
    question: 'Comment changer mon nom d’utilisateur ?',
    answer:
      'Il est fixé à la création du compte car il sert d’identifiant de connexion. Ouvre Paramètres › Modifier le profil pour changer ta photo, ton nom affiché et ta bio.',
  },
  {
    question: 'Mes messages sont-ils chiffrés ?',
    answer:
      'Les échanges transitent par le serveur de MboloChat (HTTPS + jetons JWT). Le chiffrement de bout en bout arrive dans une prochaine version.',
  },
];

/** Page d'aide. */
export default function HelpScreen() {
  const { token } = useAuth();
  const insets = useSafeAreaInsets();

  if (!token) {
    return <Redirect href="/login" />;
  }

  return (
    <ThemedView style={styles.container}>
      <Stack.Screen options={{ title: 'Aide' }} />
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + Spacing.four }}>
        <ThemedText type="smallBold" themeColor="textSecondary" style={styles.sectionTitle}>
          QUESTIONS FRÉQUENTES
        </ThemedText>
        <ThemedView style={styles.group}>
          {FAQ.map((item, index) => (
            <View
              key={item.question}
              style={[
                styles.item,
                index === FAQ.length - 1 ? null : styles.itemBorder,
              ]}>
              <ThemedText style={styles.question}>{item.question}</ThemedText>
              <ThemedText type="small" themeColor="textSecondary" style={styles.answer}>
                {item.answer}
              </ThemedText>
            </View>
          ))}
        </ThemedView>

        <ThemedText type="smallBold" themeColor="textSecondary" style={styles.sectionTitle}>
          À PROPOS
        </ThemedText>
        <ThemedView style={styles.group}>
          <View style={styles.item}>
            <ThemedText style={styles.question}>MboloChat</ThemedText>
            <ThemedText type="small" themeColor="textSecondary" style={styles.answer}>
              Messagerie temps réel — version 1.0.0
            </ThemedText>
          </View>
        </ThemedView>
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  sectionTitle: {
    letterSpacing: 0.8,
    marginTop: Spacing.three,
    marginBottom: Spacing.one,
    paddingHorizontal: Spacing.three,
  },
  group: {
    borderRadius: 12,
    overflow: 'hidden',
    marginHorizontal: Spacing.three,
  },
  item: {
    padding: Spacing.three,
    gap: Spacing.one,
  },
  itemBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e5e7eb',
  },
  question: {
    fontSize: 15,
    fontWeight: '700',
    lineHeight: 20,
  },
  answer: {
    lineHeight: 19,
  },
});
