import { Redirect, useLocalSearchParams } from 'expo-router';

import { ChatScreen } from '@/features/chat/ui/chat-screen';
import { useAuth } from '@/lib/auth-context';

/** Route unique des conversations : clair, groupes et chiffré passent par le même écran. */
export default function ChatRoute() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { token, user } = useAuth();
  if (!token || !user) return <Redirect href="/login" />;
  if (!id) return <Redirect href="/chats" />;
  return <ChatScreen conversationId={id} />;
}
