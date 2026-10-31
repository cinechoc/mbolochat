import * as Haptics from 'expo-haptics';
import { X } from 'lucide-react-native';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { ThemedText } from './themed-text';
import { Motion, Radii, Spacing } from '@/constants/theme';
import { useBottomInset } from '@/hooks/use-bottom-inset';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/hooks/use-theme';

const OFFSCREEN = 900;

interface BottomSheetProps {
  visible: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  children: ReactNode;
  /** Hauteur maximale relative à l'écran (0–1). */
  maxHeightRatio?: number;
  /** Croix de fermeture en haut à droite. */
  showClose?: boolean;
  /** Action principale, épinglée en bas, hors du défilement. */
  footer?: ReactNode;
  /** Contenu souple (liste) : la feuille occupe toute la hauteur utile. */
  fill?: boolean;
}

/**
 * L'unique feuille du bas de l'app. Montée au ressort, fond assombri en fondu,
 * fermeture par glissement de la poignée ou de l'en-tête (suivi du doigt, seuil
 * ou vitesse), par appui sur le fond, par le bouton retour Android ou par la
 * croix. Le contenu long défile sans entrer en conflit avec le glissement.
 * Respecte le réglage système « réduire les animations ».
 */
export function BottomSheet({
  visible,
  onClose,
  title,
  subtitle,
  children,
  maxHeightRatio = 0.9,
  showClose = true,
  footer,
  fill = false,
}: BottomSheetProps) {
  const theme = useTheme();
  const bottomInset = useBottomInset(Spacing.two);
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  /** Hauteur maximale calculée sur la zone utile, pas sur la fenêtre totale. */
  const usableHeight = Math.max(0, window.height - insets.top - insets.bottom);
  const maxHeight = Math.round(usableHeight * maxHeightRatio);
  const reduced = useReducedMotion();
  const [open, setOpen] = useState(visible);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const translateY = useSharedValue(OFFSCREEN);
  const backdrop = useSharedValue(0);
  /** Hauteur réelle de la feuille : une feuille courte se ferme plus vite. */
  const sheetHeight = useSharedValue(0);

  useEffect(() => {
    if (visible && __DEV__) {
      // Diagnostic : marge système vue depuis l'intérieur de la feuille.
      console.log(
        `[sheet] insets=${insets.bottom} top=${insets.top} window=${window.height} bottomInset=${bottomInset}`,
      );
    }
    if (visible) {
      // Montage différé d'une frame : la feuille doit exister avant de monter.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOpen(true);
      backdrop.value = reduced ? 1 : withTiming(1, { duration: Motion.base });
      translateY.value = reduced ? 0 : withSpring(0, Motion.spring);
      return;
    }
    backdrop.value = withTiming(0, { duration: Motion.fast });
    translateY.value = withTiming(OFFSCREEN, { duration: Motion.base }, (finished) => {
      if (finished) {
        runOnJS(setOpen)(false);
      }
    });
  }, [visible, reduced, backdrop, translateY, insets.bottom, insets.top, window.height, bottomInset]);

  // Clavier ouvert : la barre système est cachée, la marge basse devient inutile.
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => setKeyboardOpen(true));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardOpen(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  /** Fermeture au geste : le retour haptique accompagne le mouvement. */
  const dismissByDrag = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    onClose();
  }, [onClose]);

  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));
  const backdropStyle = useAnimatedStyle(() => ({ opacity: backdrop.value }));

  const pan = Gesture.Pan()
    .onUpdate((event) => {
      if (reduced) return;
      // Valeur partagée Reanimated : mutation pilotée par le geste, sur le thread natif.
      // eslint-disable-next-line react-hooks/immutability
      translateY.value = Math.max(0, event.translationY);
    })
    .onEnd((event) => {
      // Un quart de la hauteur, plafonné : une feuille de deux lignes ne peut
      // pas parcourir 120 px avant de toucher la barre système.
      const distance = Math.min(Motion.sheetDismissDistance, sheetHeight.value * 0.3);
      const shouldClose = event.translationY > distance || event.velocityY > 900;
      if (shouldClose) {
        runOnJS(dismissByDrag)();
      } else {
        // eslint-disable-next-line react-hooks/immutability
        translateY.value = reduced ? 0 : withSpring(0, Motion.spring);
      }
    });

  return (
    <Modal
      visible={open}
      transparent
      animationType="none"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}>
      {/* Une Modal est une fenêtre native séparée : le glissement n'existe que
          si la racine des gestes est aussi dans la fenêtre. */}
      <GestureHandlerRootView style={styles.root}>
        <Animated.View
          style={[styles.backdrop, backdropStyle]}
          pointerEvents="none"
        />
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Fermer"
        />
        <KeyboardAvoidingView
          pointerEvents="box-none"
          behavior="padding"
          style={styles.keyboard}>
          <Animated.View
            onLayout={(event) => {
              sheetHeight.value = event.nativeEvent.layout.height;
            }}
            style={[
              styles.sheet,
              {
                backgroundColor: theme.background,
                borderColor: theme.border,
                maxHeight,
                ...(fill ? { height: maxHeight } : null),
                // Feuille collée au bas de la fenêtre : marge système obligatoire,
                // sauf clavier ouvert où la barre système est déjà recouverte.
                paddingBottom: keyboardOpen ? Spacing.three : bottomInset,
              },
              sheetStyle,
            ]}>
            {/* Poignée et en-tête forment la zone de glissement : le contenu
                garde ses propres gestes de défilement. */}
            <GestureDetector gesture={pan}>
              <View style={styles.dragZone}>
                <View style={styles.handleZone}>
                  <View style={[styles.handle, { backgroundColor: theme.border }]} />
                </View>
                {title ? (
                  <View style={[styles.header, showClose && styles.headerWithClose]}>
                    <ThemedText type="smallBold" numberOfLines={1}>
                      {title}
                    </ThemedText>
                    {subtitle ? (
                      <ThemedText type="small" themeColor="textSecondary" numberOfLines={2}>
                        {subtitle}
                      </ThemedText>
                    ) : null}
                  </View>
                ) : (
                  <View style={styles.headerSpacer} />
                )}
              </View>
            </GestureDetector>
            {showClose ? (
              <Pressable
                onPress={onClose}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel="Fermer la feuille"
                style={({ pressed }) => [
                  styles.close,
                  { backgroundColor: theme.backgroundElement },
                  pressed && styles.pressed,
                ]}>
                <X size={18} strokeWidth={2.4} color={theme.textSecondary} />
              </Pressable>
            ) : null}
            <View style={[styles.body, fill && styles.bodyFill]}>{children}</View>
            {footer ? (
              <View style={[styles.footer, { borderTopColor: theme.border }]}>{footer}</View>
            ) : null}
          </Animated.View>
        </KeyboardAvoidingView>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
  },
  keyboard: { justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: Radii.sheet,
    borderTopRightRadius: Radii.sheet,
    borderWidth: StyleSheet.hairlineWidth,
    paddingTop: Spacing.one,
    overflow: 'hidden',
    // Une feuille haute doit laisser son contenu défiler, pas le rogner.
    flexShrink: 1,
  },
  dragZone: { paddingTop: Spacing.two },
  handleZone: {
    alignItems: 'center',
    paddingBottom: Spacing.threeHalf,
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: Radii.full,
  },
  header: {
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.two,
    gap: Spacing.half,
  },
  headerWithClose: { paddingRight: Spacing.six },
  headerSpacer: { height: Spacing.two },
  close: {
    position: 'absolute',
    top: Spacing.threeHalf,
    right: Spacing.three,
    width: Spacing.five,
    height: Spacing.five,
    borderRadius: Radii.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: 0.8 },
  body: { flexGrow: 0, flexShrink: 1 },
  bodyFill: { flexGrow: 1, flexBasis: 0 },
  footer: {
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.three,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
