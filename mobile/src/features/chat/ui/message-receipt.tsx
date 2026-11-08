import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { useChatColors } from '@/constants/chat-theme';
import { Spacing } from '@/constants/theme';
import { fr } from '@/i18n/fr';

import type { ReceiptState } from '@/features/e2ee/receipts';

/**
 * Accusé d'un message envoyé : « Reçu » (neutre) ou « Ouvert » (bleu).
 *
 * Pas de coche, pas de double coche : deux mots, rien d'autre. L'état `none`
 * n'affiche rien du tout — un destinataire hors ligne ne produit aucune
 * indication, plutôt qu'un statut trompeur.
 */
export function MessageReceiptLabel({ state }: { state: ReceiptState }) {
  const chat = useChatColors();
  if (state === 'none') return null;
  const read = state === 'read';
  return (
    <View style={styles.row}>
      <ThemedText
        type="small"
        style={[styles.label, { color: read ? chat.send : chat.secondaryText }]}>
        {read ? fr.e2eeChat.receiptRead : fr.e2eeChat.receiptDelivered}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    alignItems: 'flex-end',
    paddingTop: Spacing.half,
  },
  label: {
    fontSize: 12,
  },
});
