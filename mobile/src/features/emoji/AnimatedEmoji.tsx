import React, { memo, useCallback, useEffect, useRef } from 'react';
import { AccessibilityInfo, Pressable, Text } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { EMOJI_SOURCES } from './emojiCatalog';
import { EmojiImage } from './EmojiText';
import { toEmojiKey } from './emojiUtils';

/* -------------------------------------------------------------------------- */
/*  Animations 100 % code (Reanimated) : aucune ressource en plus, même style  */
/*  que le reste des emoji, fonctionne hors ligne.                             */
/* -------------------------------------------------------------------------- */

type Profile =
  | 'heartbeat'
  | 'laugh'
  | 'cry'
  | 'angry'
  | 'wave'
  | 'thumb'
  | 'fire'
  | 'party'
  | 'shock'
  | 'sleep'
  | 'bounce'; // animation par défaut

/** Familles d'emoji (clés sans FE0F, voir toEmojiKey). Ajoute librement des clés ici. */
const PROFILE_KEYS: Record<Exclude<Profile, 'bounce'>, string[]> = {
  heartbeat: ['2764', '1f9e1', '1f49b', '1f49a', '1f499', '1f49c', '1f5a4', '1f90d', '1f90e', '1f496', '1f497', '1f493', '1f495', '1f49e', '1f498', '1f60d', '1f970', '1f618', '1f63b'],
  laugh: ['1f602', '1f923', '1f606', '1f604', '1f601', '1f600', '1f603', '1f605', '1f639'],
  cry: ['1f622', '1f62d', '1f97a', '1f625', '1f614', '1f61e'],
  angry: ['1f621', '1f620', '1f92c', '1f624'],
  wave: ['1f44b', '1f91a', '270b', '1f590'],
  thumb: ['1f44d', '1f44e', '1f44f', '1f64f', '1f91d', '1f64c', '1f4aa', '1f44c', '270c'],
  fire: ['1f525', '2728', '1f4af'],
  party: ['1f389', '1f38a', '1f973', '1f60e'],
  shock: ['1f62e', '1f631', '1f632', '1f92f', '1f633'],
  sleep: ['1f634', '1f971', '1f62a'],
};

const PROFILE_BY_KEY: Record<string, Profile> = {};
(Object.keys(PROFILE_KEYS) as (Exclude<Profile, 'bounce'>)[]).forEach((profile) => {
  PROFILE_KEYS[profile].forEach((key) => {
    PROFILE_BY_KEY[key] = profile;
  });
});

type Values = {
  scale: SharedValue<number>;
  sy: SharedValue<number>;
  rot: SharedValue<number>;
  tx: SharedValue<number>;
  ty: SharedValue<number>;
};

const ease = Easing.inOut(Easing.quad);
const to = (value: number, duration: number) => withTiming(value, { duration, easing: ease });

function play(profile: Profile, v: Values) {
  const { scale, sy, rot, tx, ty } = v;
  switch (profile) {
    case 'heartbeat':
      scale.value = withRepeat(withSequence(to(1.22, 150), to(1, 120), to(1.14, 130), to(1, 250)), 2);
      break;
    case 'laugh':
      ty.value = withRepeat(withSequence(to(-9, 110), to(0, 110)), 5);
      rot.value = withSequence(withRepeat(withSequence(to(-8, 100), to(8, 100)), 4), to(0, 100));
      break;
    case 'cry':
      ty.value = withRepeat(withSequence(to(5, 350), to(0, 350)), 2);
      scale.value = withSequence(to(0.93, 350), to(1, 350), to(0.96, 350), to(1, 350));
      break;
    case 'angry':
      tx.value = withSequence(withRepeat(withSequence(to(-5, 45), to(5, 45)), 8), to(0, 45));
      scale.value = withSequence(to(1.12, 200), to(1, 300));
      break;
    case 'wave':
      rot.value = withSequence(to(-20, 140), to(18, 200), to(-16, 200), to(14, 200), to(-8, 160), to(0, 140));
      break;
    case 'thumb':
      scale.value = withSequence(to(1.22, 140), withSpring(1, { damping: 6, stiffness: 200 }));
      rot.value = withSequence(to(-20, 120), withSpring(0, { damping: 5, stiffness: 180 }));
      break;
    case 'fire':
      sy.value = withSequence(withRepeat(withSequence(to(1.1, 150), to(0.95, 150)), 4), to(1, 120));
      scale.value = withSequence(to(1.08, 200), to(1, 400));
      break;
    case 'party':
      ty.value = withSequence(to(-18, 160), withSpring(0, { damping: 6, stiffness: 220 }));
      rot.value = withSequence(withRepeat(withSequence(to(-12, 110), to(12, 110)), 3), to(0, 100));
      break;
    case 'shock':
      scale.value = withSequence(to(1.35, 90), to(1.2, 220), to(1, 260));
      tx.value = withSequence(withRepeat(withSequence(to(-3, 50), to(3, 50)), 4), to(0, 50));
      break;
    case 'sleep':
      ty.value = withRepeat(withSequence(to(4, 650), to(0, 650)), 2);
      rot.value = withSequence(to(-7, 650), to(0, 650), to(-4, 650), to(0, 650));
      break;
    default:
      ty.value = withSequence(to(-14, 150), to(0, 150), to(-6, 100), to(0, 100));
      sy.value = withSequence(to(0.94, 100), to(1.04, 150), to(1, 100));
  }
}

/** Messages déjà animés pendant cette session : un message ne s'anime qu'UNE fois à l'arrivée. */
const played = new Set<string>();

type Props = {
  /** Le caractère emoji (un seul). */
  emoji: string;
  /** Identifiant du message, pour ne pas rejouer l'animation quand la liste se redessine. */
  messageId: string;
  /** Vrai si le message vient d'être envoyé/reçu (ex. créé il y a moins de 15 s). Faux pour l'historique. */
  fresh: boolean;
  size?: number;
};

/**
 * Message composé d'UN seul emoji : grand, SANS bulle, animé à l'arrivée,
 * et rejouable en le touchant (avec une petite vibration), comme sur WhatsApp.
 * L'animation est coupée si l'utilisateur a activé « réduire les animations ».
 */
export const SingleEmojiMessage = memo(function SingleEmojiMessage({ emoji, messageId, fresh, size = 72 }: Props) {
  const key = toEmojiKey(emoji);
  const profile: Profile = PROFILE_BY_KEY[key] ?? 'bounce';

  const animateIn = fresh && !played.has(messageId);
  const scale = useSharedValue(animateIn ? 0.35 : 1);
  const opacity = useSharedValue(animateIn ? 0 : 1);
  const sy = useSharedValue(1);
  const rot = useSharedValue(0);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);

  const reduceMotion = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reset = useCallback(() => {
    [scale, sy, rot, tx, ty].forEach((v) => cancelAnimation(v));
    scale.value = 1;
    sy.value = 1;
    rot.value = 0;
    tx.value = 0;
    ty.value = 0;
  }, [scale, sy, rot, tx, ty]);

  useEffect(() => {
    let cancelled = false;
    if (animateIn) played.add(messageId);

    AccessibilityInfo.isReduceMotionEnabled()
      .then((reduced) => {
        if (cancelled) return;
        reduceMotion.current = reduced;
        if (!animateIn) return;
        if (reduced) {
          scale.value = 1;
          opacity.value = 1;
          return;
        }
        scale.value = withSpring(1, { damping: 7, stiffness: 170, mass: 0.8 });
        opacity.value = withTiming(1, { duration: 140 });
        timer.current = setTimeout(() => play(profile, { scale, sy, rot, tx, ty }), 450);
      })
      .catch(() => {
        scale.value = 1;
        opacity.value = 1;
      });

    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
    // Lancé une seule fois au montage.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onPress = () => {
    if (reduceMotion.current) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    reset();
    play(profile, { scale, sy, rot, tx, ty });
  };

  const style = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [
      { translateX: tx.value },
      { translateY: ty.value },
      { rotate: `${rot.value}deg` },
      { scale: scale.value },
      { scaleY: sy.value },
    ],
  }));

  return (
    <Pressable onPress={onPress} hitSlop={8} accessibilityRole="image" accessibilityLabel={`Emoji ${emoji}`}>
      <Animated.View style={style}>
        {EMOJI_SOURCES[key] ? (
          <EmojiImage emojiKey={key} size={size} large />
        ) : (
          <Text style={{ fontSize: size * 0.85 }}>{emoji}</Text> // emoji absent du pack : police du système
        )}
      </Animated.View>
    </Pressable>
  );
});
