import { describe, expect, it } from 'vitest';

import { interpretVideoToggleAck } from './videoPolicy';

describe('interpretVideoToggleAck', () => {
  it('accepte une autorisation explicite', () => {
    expect(interpretVideoToggleAck({ ok: true })).toEqual({ allowed: true, capped: false });
  });

  it('identifie un refus pour plafond de caméras', () => {
    expect(interpretVideoToggleAck({ ok: false, error: 'full' })).toEqual({
      allowed: false,
      capped: true,
    });
  });

  it('distingue les autres refus', () => {
    expect(interpretVideoToggleAck({ ok: false, error: 'invalid' })).toEqual({
      allowed: false,
      capped: false,
    });
  });

  it('ne bloque pas quand le serveur ne répond pas', () => {
    expect(interpretVideoToggleAck(null)).toEqual({ allowed: true, capped: false });
    expect(interpretVideoToggleAck(undefined)).toEqual({ allowed: true, capped: false });
    expect(interpretVideoToggleAck('smoke')).toEqual({ allowed: true, capped: false });
    expect(interpretVideoToggleAck({})).toEqual({ allowed: true, capped: false });
  });
});
