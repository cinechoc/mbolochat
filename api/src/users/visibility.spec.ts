import { describe, expect, it } from 'vitest';

import { canSee } from './visibility.js';

const STRANGER = { isContact: false, blocked: false };
const CONTACT = { isContact: true, blocked: false };
const BLOCKED = { isContact: true, blocked: true };

describe('canSee', () => {
  it('« tout le monde » autorise les inconnus, sauf blocage', () => {
    expect(canSee('everyone', STRANGER)).toBe(true);
    expect(canSee('everyone', BLOCKED)).toBe(false);
  });

  it('« mes contacts » exige une conversation partagée', () => {
    expect(canSee('contacts', CONTACT)).toBe(true);
    expect(canSee('contacts', STRANGER)).toBe(false);
  });

  it('« personne » refuse toujours, même un contact', () => {
    expect(canSee('nobody', CONTACT)).toBe(false);
  });
});
