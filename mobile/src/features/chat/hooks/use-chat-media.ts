import { useCallback, useState } from 'react';

export interface ChatDocumentTarget {
  url: string;
  name: string;
  mime: string;
  size: number;
}

/**
 * État local des visionneuses. Toutes les actions sont stables : l'écran peut
 * les passer telles quelles aux composants mémoïsés.
 */
export function useChatMedia(): {
  image: { urls: string[]; index: number } | null;
  video: string | null;
  document: ChatDocumentTarget | null;
  openImage: (urls: string[], index: number) => void;
  openVideo: (url: string) => void;
  openDocument: (target: ChatDocumentTarget) => void;
  closeImage: () => void;
  closeVideo: () => void;
  closeDocument: () => void;
} {
  const [image, setImage] = useState<{ urls: string[]; index: number } | null>(null);
  const [video, setVideo] = useState<string | null>(null);
  const [document, setDocument] = useState<ChatDocumentTarget | null>(null);

  const openImage = useCallback((urls: string[], index: number) => {
    setImage({ urls, index: Math.max(0, Math.min(index, urls.length - 1)) });
  }, []);
  const openVideo = useCallback((url: string) => setVideo(url), []);
  const openDocument = useCallback((target: ChatDocumentTarget) => setDocument(target), []);
  const closeImage = useCallback(() => setImage(null), []);
  const closeVideo = useCallback(() => setVideo(null), []);
  const closeDocument = useCallback(() => setDocument(null), []);

  return {
    image,
    video,
    document,
    openImage,
    openVideo,
    openDocument,
    closeImage,
    closeVideo,
    closeDocument,
  };
}
