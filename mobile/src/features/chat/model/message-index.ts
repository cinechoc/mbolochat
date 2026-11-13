/**
 * Index trié des messages, par identifiant.
 *
 * Deux opérations remplacent le tri complet à chaque arrivée :
 *  - `get(id)` en O(1) pour résoudre une citation (fini le `find` par ligne) ;
 *  - `upsert` par recherche binaire, pour insérer au bon endroit sans retrier.
 *
 * L'équivalence avec un tri complet est prouvée par `message-index.test.ts`.
 */
export interface IndexedMessage {
  id: string;
  createdAt: string;
}

function compareCreatedAt(a: IndexedMessage, b: IndexedMessage): number {
  if (a.createdAt < b.createdAt) return -1;
  if (a.createdAt > b.createdAt) return 1;
  return 0;
}

export class MessageIndex<T extends IndexedMessage> {
  private readonly byId = new Map<string, T>();
  private ordered: T[] = [];

  constructor(initial: readonly T[] = []) {
    for (const item of initial) {
      this.upsert(item);
    }
  }

  get size(): number {
    return this.ordered.length;
  }

  get(id: string): T | undefined {
    return this.byId.get(id);
  }

  values(): readonly T[] {
    return this.ordered;
  }

  /**
   * Insère ou remplace un message. Un remplacement repositionne l'élément si
   * son horodatage a changé (écho serveur d'une bulle optimiste).
   */
  upsert(message: T): void {
    const existing = this.byId.get(message.id);
    if (existing) {
      this.removeFromOrdered(existing);
    }
    this.byId.set(message.id, message);
    this.insertOrdered(message);
  }

  remove(id: string): boolean {
    const existing = this.byId.get(id);
    if (!existing) {
      return false;
    }
    this.byId.delete(id);
    this.removeFromOrdered(existing);
    return true;
  }

  clear(): void {
    this.byId.clear();
    this.ordered = [];
  }

  /** Borne supérieure : à horodatage égal, l'ordre d'insertion est conservé. */
  private insertOrdered(message: T): void {
    let low = 0;
    let high = this.ordered.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (compareCreatedAt(this.ordered[middle], message) <= 0) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    this.ordered.splice(low, 0, message);
  }

  private removeFromOrdered(message: T): void {
    const index = this.ordered.indexOf(message);
    if (index >= 0) {
      this.ordered.splice(index, 1);
    }
  }
}
