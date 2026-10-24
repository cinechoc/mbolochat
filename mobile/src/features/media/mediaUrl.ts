import { API_URL } from '@/lib/config';

/** Les médias arrivent en chemin relatif signé et éphémère (« /media?f=… »). */
export function mediaUrl(url: string): string {
  return /^(https?:|file:|content:|data:)/i.test(url) ? url : `${API_URL}${url}`;
}
