import { describe, expect, it } from 'vitest';

import { pushLiveLevel } from './voiceRecordingLevels';

describe('forme d’onde pendant l’enregistrement', () => {
  it('conserve une fenêtre bornée et ajoute le dernier niveau', () => {
    expect(pushLiveLevel([0.1, 0.2], 0.3, 3)).toEqual([0.1, 0.2, 0.3]);
    expect(pushLiveLevel([0.1, 0.2, 0.3], 0.4, 3)).toEqual([0.2, 0.3, 0.4]);
  });
});
