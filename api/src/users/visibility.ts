/**
 * Visibilité « tout le monde / mes contacts / personne », appliquée par l'API.
 * Les contacts sont les personnes qui partagent une conversation (directe ou
 * groupe) avec la personne concernée — même définition que la présence.
 */
export type Visibility = 'everyone' | 'contacts' | 'nobody';

export interface ViewerRelation {
  /** Une conversation est partagée entre la cible et le visiteur. */
  isContact: boolean;
  /** L'un des deux a bloqué l'autre. */
  blocked: boolean;
}

export function canSee(visibility: Visibility, relation: ViewerRelation): boolean {
  if (relation.blocked) {
    return false;
  }
  if (visibility === 'everyone') {
    return true;
  }
  if (visibility === 'contacts') {
    return relation.isContact;
  }
  return false;
}
