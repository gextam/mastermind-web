/* ============================================================================
   MASTERMIND — client configuration: stage, layout, timing, storage keys.
   ========================================================================== */
(function (root) {
  'use strict';
  const MM = root.MM || (root.MM = {});
  MM.CONFIG = {
    STAGE: { w: 1920, h: 1080 },
    /* the decoding board stands in the centre; the peg tray lies under it;
       the left column holds the logo, status and controls, the right column the scoreboard */
    LAYOUT: {
      boardCx: 960, boardTop: 44, boardBottom: 858, shieldH: 92, boardPad: 26, keyGap: 28,
      pegPitchMax: 76, pegRadiusMax: 27, rowPitchMax: 70,
      trayY: 896, trayH: 150, trayW: 640,
      leftX: 60, leftW: 600, rightX: 1262, rightW: 598
    },
    TIMING: { drop: 0.28, keyStart: 0.42, keyGap: 0.17, revealDelay: 0.55, shield: 0.9, solverStep: 1.35, resultHold: 1.4, toast: 2.6 },
    STORAGE: { game: 'mastermind.game', player: 'mastermind.player', records: 'mastermind.records', prefs: 'mastermind.prefs' },
    DEFAULT_PLAYER: 'You',
    VERSION: '1.0.0'
  };
})(window);
