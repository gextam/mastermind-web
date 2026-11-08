/* ============================================================================
   MASTERMIND — bootstrap, frame loop, test hooks.
   ?mute=1 silent · ?local=1 force the in-browser game (no server) ·
   ?player=Name · MM.step(seconds) advances the simulation deterministically
   ========================================================================== */
(function (root) {
  'use strict';
  const MM = root.MM;
  root.addEventListener('load', () => {
    const q = new URLSearchParams(root.location.search);
    const client = new MM.Client();
    const game = new MM.Game(client);
    try { game.player = q.get('player') || localStorage.getItem(MM.CONFIG.STORAGE.player) || MM.CONFIG.DEFAULT_PLAYER; } catch (e) { game.player = MM.CONFIG.DEFAULT_PLAYER; }
    const renderer = new MM.Renderer(document.getElementById('game'), game);
    const ui = new MM.UI(game, renderer, client);
    MM.client = client; MM.game = game; MM.renderer = renderer; MM.ui = ui;
    ui.buildHelp();
    const assets = MM.Assets.load({ table: 'assets/bg/table.jpg', walnut: 'assets/walnut.jpg', logo: 'assets/logo.png' });
    const probe = client.init(q.get('local') === '1');
    Promise.all([assets, probe]).then(() => {
      ui.refreshOnline();
      document.getElementById('splash-text').textContent = 'CLICK TO TAKE A SEAT';
      document.getElementById('splash').classList.add('ready');
      MM.loaded = true;
    });

    MM.timeOffset = 0;
    const clock = () => performance.now() / 1000 + MM.timeOffset;
    let last = clock();
    function tick(now, dt, draw) { game.update(now, dt); if (draw) renderer.draw(now); }
    function frame() { const now = clock(), dt = Math.min(0.05, Math.max(0, now - last)); last = now; tick(now, dt, true); requestAnimationFrame(frame); }
    requestAnimationFrame(frame);
    MM.step = function (seconds) { const h = 1 / 60, n = Math.max(1, Math.round(seconds / h)); for (let i = 0; i < n; i++) { MM.timeOffset += h; const now = clock(); last = now; tick(now, h, i === n - 1); } };
    document.addEventListener('visibilitychange', () => { if (!document.hidden && MM.audio.ctx) MM.audio.ctx.resume(); });
  });
})(window);
