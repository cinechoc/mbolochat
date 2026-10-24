import { useColorScheme } from '@/hooks/use-color-scheme';
import { Colors } from './theme';

/** Écart au-delà duquel on réaffiche une heure entre deux messages. */
export const CHAT_TIME_GAP_MS = 5 * 60 * 1000;

export interface ChatPalette {
  screen: string;
  primaryText: string;
  secondaryText: string;
  border: string;
  mineBubble: string;
  theirBubble: string;
  mineText: string;
  theirText: string;
  composer: string;
  input: string;
  inputPlaceholder: string;
  send: string;
  sendText: string;
  headerText: string;
  headerSubtitle: string;
  dateText: string;
  systemText: string;
  unreadText: string;
  tick: string;
  error: string;
  voiceBarOff: string;
  voiceBarOn: string;
  quoteBackground: string;
  quoteBackgroundMine: string;
  quoteBar: string;
  quoteBarMine: string;
  quoteText: string;
  quoteName: string;
}

export const ChatColors: { light: ChatPalette; dark: ChatPalette } = {
  light: {
    screen: '#EDEDED',
    primaryText: '#111111',
    secondaryText: '#9B9B9B',
    border: '#D6D6D6',
    mineBubble: '#95EC69',
    theirBubble: '#FFFFFF',
    mineText: '#111111',
    theirText: '#111111',
    composer: '#F7F7F7',
    input: '#FFFFFF',
    inputPlaceholder: '#9B9B9B',
    send: '#07C160',
    sendText: '#FFFFFF',
    headerText: '#111111',
    headerSubtitle: '#9B9B9B',
    dateText: '#9B9B9B',
    systemText: '#9B9B9B',
    unreadText: '#9B9B9B',
    tick: '#445B49',
    error: '#FA5151',
    voiceBarOff: 'rgba(0,0,0,0.22)',
    voiceBarOn: '#111111',
    quoteBackground: 'rgba(0,0,0,0.06)',
    quoteBackgroundMine: 'rgba(0,0,0,0.10)',
    quoteBar: '#07C160',
    quoteBarMine: '#111111',
    quoteText: '#5F6B61',
    quoteName: '#111111',
  },
  dark: {
    screen: Colors.dark.background,
    primaryText: Colors.dark.text,
    secondaryText: Colors.dark.textSecondary,
    border: Colors.dark.backgroundElement,
    mineBubble: '#2F6B3B',
    theirBubble: Colors.dark.backgroundElement,
    mineText: '#F5F5F5',
    theirText: Colors.dark.text,
    composer: Colors.dark.backgroundElement,
    input: '#2C2C2E',
    inputPlaceholder: '#9B9B9B',
    send: '#07C160',
    sendText: '#FFFFFF',
    headerText: Colors.dark.text,
    headerSubtitle: Colors.dark.textSecondary,
    dateText: Colors.dark.textSecondary,
    systemText: Colors.dark.textSecondary,
    unreadText: Colors.dark.textSecondary,
    tick: '#C8D8CC',
    error: Colors.dark.error,
    voiceBarOff: 'rgba(255,255,255,0.25)',
    voiceBarOn: '#F5F5F5',
    quoteBackground: 'rgba(255,255,255,0.08)',
    quoteBackgroundMine: 'rgba(255,255,255,0.12)',
    quoteBar: '#07C160',
    quoteBarMine: '#F5F5F5',
    quoteText: '#C7C7CC',
    quoteName: Colors.dark.text,
  },
};

export function useChatColors(): ChatPalette {
  const scheme = useColorScheme();
  return scheme === 'dark' ? ChatColors.dark : ChatColors.light;
}
