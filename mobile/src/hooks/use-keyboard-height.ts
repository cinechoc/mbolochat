import { useEffect, useRef, useState } from 'react';
import {
  Dimensions,
  Keyboard,
  Platform,
  useWindowDimensions,
  type KeyboardEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * Hauteur (en px) à réserver en bas de l'écran pour le clavier logiciel.
 *
 * - iOS : toujours 0, le `KeyboardAvoidingView` s'en charge déjà.
 * - Android : la hauteur réelle du clavier (événement `keyboardDidShow`).
 *   Deux cas sont distinguished :
 *     • la fenêtre a été rétrécie par Android (`adjustResize`) → la place est
 *       déjà faite par le layout, on ne compense pas ;
 *     • la fenêtre n'a pas bougé (edge-to-edge, défaut sur Android 15+) → on
 *       réserve nous-mêmes la hauteur du clavier, plus la barre de navigation
 *       système qui se trouve sous celui-ci.
 */
export function useKeyboardHeight(): number {
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const [height, setHeight] = useState(0);
  const baselineRef = useRef(window.height);
  const previousRef = useRef({ width: window.width, height: window.height });
  const keyboardOpenRef = useRef(false);

  // La hauteur de référence suit l'orientation, mais pas les rétrécissements
  // causés par le clavier (sinon on croirait la fenêtre déjà ajustée).
  useEffect(() => {
    const rotated = window.width !== previousRef.current.width;
    const grew = window.height > previousRef.current.height;
    if (!keyboardOpenRef.current && (rotated || grew)) {
      baselineRef.current = window.height;
    }
    previousRef.current = { width: window.width, height: window.height };
  }, [window.width, window.height]);

  useEffect(() => {
    if (Platform.OS !== 'android') {
      return;
    }

    const onShow = (event: KeyboardEvent) => {
      keyboardOpenRef.current = true;
      const current = Dimensions.get('window').height;
      const baseline = baselineRef.current ?? current;
      const keyboard = event.endCoordinates.height;
      const shrunk = baseline - current;
      // Android a-t-il déjà rétréci la fenêtre pour le clavier ?
      const windowAlreadyResized = shrunk >= keyboard * 0.5;
      setHeight(windowAlreadyResized ? 0 : keyboard + insets.bottom);
    };

    const onHide = () => {
      keyboardOpenRef.current = false;
      baselineRef.current = Dimensions.get('window').height;
      setHeight(0);
    };

    const showSubscription = Keyboard.addListener('keyboardDidShow', onShow);
    const hideSubscription = Keyboard.addListener('keyboardDidHide', onHide);
    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, [insets.bottom]);

  return height;
}
