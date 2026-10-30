import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { Gutter } from '@/constants/theme';
import { useBottomInset } from '@/hooks/use-bottom-inset';

/**
 * Conteneur d'écran : garde toujours le contenu au-dessus de la barre système.
 * `scroll` remplace la vue par une liste défilante dont le contenu est décollé
 * du bas. Les nouveaux écrans passent par ici plutôt que par un padding local.
 */
export function Screen({
  children,
  style,
  scroll = false,
  contentStyle,
  keyboardShouldPersistTaps,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  scroll?: boolean;
  contentStyle?: StyleProp<ViewStyle>;
  keyboardShouldPersistTaps?: 'always' | 'handled' | 'never';
}) {
  const bottom = useBottomInset(Gutter);

  if (scroll) {
    return (
      <ScrollView
        style={[styles.flex, style]}
        contentContainerStyle={[{ paddingBottom: bottom }, contentStyle]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps={keyboardShouldPersistTaps}>
        {children}
      </ScrollView>
    );
  }

  return (
    <View style={[styles.flex, { paddingBottom: bottom }, style]}>{children}</View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
});
