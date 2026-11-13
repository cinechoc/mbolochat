import { describe, expect, it } from 'vitest';

import { createMediaLeaseRegistry } from './media-leases';

describe('media-leases', () => {
  it('ferme le média de la visionneuse à sa sortie', () => {
    const leases = createMediaLeaseRegistry();
    leases.setViewer('upload-image');
    expect(leases.releaseViewer()).toBe('upload-image');
    expect(leases.releaseViewer()).toBeNull();
  });

  it('ferme le document au retour de la route document', () => {
    const leases = createMediaLeaseRegistry();
    leases.setDocument('upload-document');
    expect(leases.releaseDocument()).toBe('upload-document');
    expect(leases.releaseDocument()).toBeNull();
  });

  it('draine tous les baux au démontage', () => {
    const leases = createMediaLeaseRegistry();
    leases.setViewer('image');
    leases.setDocument('document');
    expect(leases.drain().sort()).toEqual(['document', 'image']);
    expect(leases.drain()).toEqual([]);
  });
});
