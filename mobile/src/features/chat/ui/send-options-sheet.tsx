import { DateTimePicker } from '@expo/ui/community/datetime-picker';
import { BellOff, CalendarClock, Eye, X } from 'lucide-react-native';
import { useState } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Radii, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useThemePreference } from '@/lib/theme-preference';
import { fr } from '@/i18n/fr';
import { defaultScheduledAt, isValidScheduledAt } from '../model/send-options';

type Props = {
  visible: boolean;
  onClose: () => void;
  onSendSilent: () => void;
  onSendViewOnce: () => void;
  onSchedule: (date: Date) => void;
};

type PickerMode = 'date' | 'time';

function formatSchedule(date: Date): string {
  return new Intl.DateTimeFormat('fr-FR', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function SendOptionsSheet({
  visible,
  onClose,
  onSendSilent,
  onSendViewOnce,
  onSchedule,
}: Props) {
  const theme = useTheme();
  const { scheme } = useThemePreference();
  const [scheduling, setScheduling] = useState(false);
  const [scheduledAt, setScheduledAt] = useState(() => defaultScheduledAt());
  const [picker, setPicker] = useState<PickerMode | null>(null);

  const validSchedule = isValidScheduledAt(scheduledAt.toISOString());

  const closeAll = () => {
    setPicker(null);
    setScheduling(false);
    onClose();
  };

  const action = (icon: React.ReactNode, label: string, detail: string, onPress: () => void) => (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.action,
        { backgroundColor: pressed ? theme.backgroundSelected : theme.backgroundElement },
      ]}>
      <View style={[styles.actionIcon, { backgroundColor: theme.accentSoft }]}>{icon}</View>
      <View style={styles.actionCopy}>
        <ThemedText type="smallBold" style={{ color: theme.text }}>
          {label}
        </ThemedText>
        <ThemedText type="micro" style={{ color: theme.textSecondary }}>
          {detail}
        </ThemedText>
      </View>
    </Pressable>
  );

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={closeAll}>
      <Pressable style={styles.backdrop} onPress={closeAll} accessibilityLabel={fr.common.close}>
        <Pressable
          onPress={(event) => event.stopPropagation()}
          style={[styles.sheet, { backgroundColor: theme.background, borderColor: theme.border }]}>
          <View style={styles.header}>
            <ThemedText type="sectionTitle" style={{ color: theme.text }}>
              {scheduling ? fr.chat.sendOptions.scheduleTitle : fr.chat.sendOptions.title}
            </ThemedText>
            <Pressable
              onPress={closeAll}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel={fr.common.close}>
              <X size={20} strokeWidth={2.2} color={theme.textSecondary} />
            </Pressable>
          </View>

          {scheduling ? (
            <View style={styles.scheduleBody}>
              <ThemedText type="caption" style={{ color: theme.textSecondary }}>
                {fr.chat.sendOptions.scheduleHint}
              </ThemedText>
              <View
                style={[
                  styles.scheduleValue,
                  { backgroundColor: theme.backgroundElement, borderColor: theme.border },
                ]}>
                <CalendarClock size={20} strokeWidth={2.1} color={theme.accent} />
                <ThemedText type="smallBold" style={[styles.flex, { color: theme.text }]}>
                  {formatSchedule(scheduledAt)}
                </ThemedText>
                <Pressable
                  onPress={() => setPicker('date')}
                  accessibilityRole="button"
                  accessibilityLabel={fr.chat.sendOptions.pickDate}
                  style={styles.pickButton}>
                  <ThemedText type="smallBold" style={{ color: theme.accent }}>
                    {fr.chat.sendOptions.date}
                  </ThemedText>
                </Pressable>
                <Pressable
                  onPress={() => setPicker('time')}
                  accessibilityRole="button"
                  accessibilityLabel={fr.chat.sendOptions.pickTime}
                  style={styles.pickButton}>
                  <ThemedText type="smallBold" style={{ color: theme.accent }}>
                    {fr.chat.sendOptions.time}
                  </ThemedText>
                </Pressable>
              </View>
              {!validSchedule ? (
                <ThemedText type="micro" style={{ color: theme.danger }}>
                  {fr.chat.sendOptions.scheduleTooSoon}
                </ThemedText>
              ) : null}
              <Pressable
                disabled={!validSchedule}
                onPress={() => {
                  onSchedule(scheduledAt);
                  closeAll();
                }}
                accessibilityRole="button"
                accessibilityLabel={fr.chat.sendOptions.confirmSchedule}
                style={({ pressed }) => [
                  styles.confirm,
                  { backgroundColor: theme.accent, opacity: !validSchedule ? 0.45 : pressed ? 0.8 : 1 },
                ]}>
                <ThemedText type="smallBold" style={{ color: theme.onAccent }}>
                  {fr.chat.sendOptions.confirmSchedule}
                </ThemedText>
              </Pressable>
            </View>
          ) : (
            <View style={styles.actions}>
              {action(
                <CalendarClock size={21} strokeWidth={2.1} color={theme.accent} />,
                fr.chat.sendOptions.schedule,
                fr.chat.sendOptions.scheduleDetail,
                () => {
                  setScheduledAt(defaultScheduledAt());
                  setScheduling(true);
                },
              )}
              {action(
                <BellOff size={21} strokeWidth={2.1} color={theme.accent} />,
                fr.chat.sendOptions.silent,
                fr.chat.sendOptions.silentDetail,
                () => {
                  onSendSilent();
                  closeAll();
                },
              )}
              {action(
                <Eye size={21} strokeWidth={2.1} color={theme.accent} />,
                fr.chat.sendOptions.viewOnce,
                fr.chat.sendOptions.viewOnceDetail,
                () => {
                  onSendViewOnce();
                  closeAll();
                },
              )}
            </View>
          )}
        </Pressable>
      </Pressable>

      {picker ? (
        <DateTimePicker
          value={scheduledAt}
          mode={picker}
          presentation="dialog"
          minimumDate={new Date()}
          is24Hour
          accentColor={theme.accent}
          themeVariant={scheme}
          positiveButton={{ label: fr.common.save }}
          negativeButton={{ label: fr.common.cancel }}
          onDismiss={() => setPicker(null)}
          onValueChange={(_event, date) => {
            const next = new Date(scheduledAt);
            if (picker === 'date') {
              next.setFullYear(date.getFullYear(), date.getMonth(), date.getDate());
            } else {
              next.setHours(date.getHours(), date.getMinutes(), 0, 0);
            }
            setScheduledAt(next);
            setPicker(null);
          }}
        />
      ) : null}
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    alignItems: 'center',
    padding: Spacing.three,
    backgroundColor: 'rgba(0,0,0,0.48)',
  },
  sheet: {
    width: '100%',
    maxWidth: 520,
    borderRadius: Radii.sheet,
    borderWidth: StyleSheet.hairlineWidth,
    padding: Spacing.three,
    gap: Spacing.two,
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  actions: { gap: Spacing.one },
  action: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    borderRadius: Radii.sm,
    padding: Spacing.two,
  },
  actionIcon: { width: 36, height: 36, borderRadius: Radii.full, alignItems: 'center', justifyContent: 'center' },
  actionCopy: { flex: 1, gap: 1 },
  scheduleBody: { gap: Spacing.two },
  scheduleValue: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Radii.sm,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
  },
  flex: { flex: 1 },
  pickButton: { minHeight: 44, justifyContent: 'center', paddingHorizontal: Spacing.one },
  confirm: { minHeight: 46, alignItems: 'center', justifyContent: 'center', borderRadius: Radii.button },
});
