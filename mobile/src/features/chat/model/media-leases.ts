/**
 * Registre pur des baux de médias déchiffrés ouverts par l'écran.
 *
 * Un média chiffré ne doit rester en clair que pendant la vie de sa
 * visionneuse, ou jusqu'au retour de la route document. Chaque chemin
 * (image/vidéo, document) a son bail ; `drain` couvre le démontage.
 */
export interface MediaLeaseRegistry {
  setViewer(id: string): void;
  releaseViewer(): string | null;
  setDocument(id: string): void;
  releaseDocument(): string | null;
  drain(): string[];
}

export function createMediaLeaseRegistry(): MediaLeaseRegistry {
  let viewer: string | null = null;
  let document: string | null = null;
  return {
    setViewer(id) {
      viewer = id;
    },
    releaseViewer() {
      const id = viewer;
      viewer = null;
      return id;
    },
    setDocument(id) {
      document = id;
    },
    releaseDocument() {
      const id = document;
      document = null;
      return id;
    },
    drain() {
      const ids = [viewer, document].filter((id): id is string => Boolean(id));
      viewer = null;
      document = null;
      return ids;
    },
  };
}
