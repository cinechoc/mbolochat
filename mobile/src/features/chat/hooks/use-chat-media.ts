import { useCallback, useState } from 'react';

export interface ChatDocumentTarget {
  url: string;
  name: string;
  mime: string;
  size: number;
}

/**
 * État local des visionneuses. La fermeture d'un média chiffré est déléguée à
 * l'écran (`closeMedia`), qui seul sait quel clair temporaire libérer.
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

  return {
    image,
    video,
    document,
    openImage,
    openVideo: setVideo,
    openDocument: setDocument,
    closeImage: () => setImage(null),
    closeVideo: () => setVideo(null),
    closeDocument: () => setDocument(null),
  };
}
