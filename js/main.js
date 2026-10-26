/* ==========================================================================
   main.js — game state machine, fixed-step loop, menus and HUD.

   Turn-based state machine:

     MENU ──start──▶ PLAYER_AIM ──release──▶ SIMULATING ──pens settled──▶ AI_THINK
                         ▲                      │   │                        │
                         │                      │   └─pen falls─▶ GAME_OVER  ▼
                         └────pens settled──────┘◀──────release──────── AI_AIM

   A match starts in PLAYER_AIM or AI_THINK — the first move alternates.
   Input is only accepted in PLAYER_AIM. In SIMULATING we wait until BOTH
   pens' linear and angular speeds stay below tiny thresholds before handing
   the turn over.
   ========================================================================== */
(function (PG) {
  'use strict';

  if (!window.Matter) {
    document.body.innerHTML =
      '<p style="font:18px system-ui;color:#eee;padding:40px;text-align:center">' +
      'Could not load the Matter.js physics engine from the CDN.<br>Please check your internet connection and reload.</p>';
    return;
  }

  const U = PG.util;
  const P = PG.PHYSICS;
  const D = PG.DESK;
  const AIS = PG.AI_SETTINGS;

  const STATE = Object.freeze({
    MENU: 'menu',
    PLAYER_AIM: 'player-aim',
    AI_THINK: 'ai-think',
    AI_AIM: 'ai-aim',
    SIMULATING: 'simulating',
    GAME_OVER: 'game-over',
  });

  const FALL_MS = 800;
  const NAME = PG.PLAYER_NAME || 'Player';

  /* ---------------- DOM ---------------- */
  const $ = (id) => document.getElementById(id);
  const ui = {
    stage: $('stage'),
    canvas: $('game'),
    hud: $('hud'),
    footer: $('footer'),
    pill: $('turn-pill'),
    status: $('turn-status'),
    hudPlayerName: $('hud-player-name'),
    hudPlayerPen: $('hud-player-pen'),
    greeting: $('greeting'),
    hudAiPen: $('hud-ai-pen'),
    hudAiName: $('hud-ai-name'),
    banner: $('turn-banner'),
    btnMenu: $('btn-menu'),
    menu: $('menu'),
    penCards: $('pen-cards'),
    diffRow: $('diff-row'),
    diffDesc: $('diff-desc'),
    btnStart: $('btn-start'),
    gameover: $('gameover'),
    goTitle: $('go-title'),
    goReason: $('go-reason'),
    goStats: $('go-stats'),
    btnAgain: $('btn-again'),
    btnSetup: $('btn-setup'),
  };

  const renderer = PG.createRenderer(ui.canvas, ui.stage);

  /* ---------------- game state ---------------- */
  const game = {
    state: STATE.MENU,
    stateTime: 0,
    matchId: 0,
    matchesPlayed: 0, // drives who shoots first (alternates each match)
    settings: { penId: 'ballpoint', difficulty: 'medium' },
    physics: null,
    pens: null, // { player, ai }
    shooter: null, // 'player' | 'ai'
    turnNumber: 0,
    simTime: 0,
    settleTicks: 0,
    outcome: null,
    aiTask: null,
    aiShot: null,
    effects: [],
    shake: 0,
    time: 0,
  };

  const input = PG.createInput(ui.canvas, {
    toWorld: renderer.toWorld,
    hitTest(pt) {
      if (game.state !== STATE.PLAYER_AIM) return null; // ← the input lock
      const body = game.pens.player.body;
      return game.physics.hitTestPen(body, pt.x, pt.y, PG.INPUT.GRAB_TOLERANCE);
    },
    onRelease(aim) {
      if (game.state === STATE.PLAYER_AIM) flick(game.pens.player, aim.angle, aim.power, aim.offset);
    },
  });

  /* ---------------- state transitions ---------------- */

  function setState(s) {
    game.state = s;
    game.stateTime = 0;
    updateHud();
  }

  function makePen(physics, owner, def, x, y, angle) {
    return {
      owner,
      def,
      colorway: PG.COLORWAYS[owner],
      body: physics.addPen(def, x, y, angle, owner),
      off: false,
      fall: null,
    };
  }

  function startMatch() {
    game.matchId++;
    const physics = PG.createPhysics();
    physics.onPenCollision(onImpact);

    const playerDef = PG.PENS[game.settings.penId];
    const aiDef = PG.PENS[U.pick(PG.PEN_ORDER)];
    // The first move alternates between matches (you start the very first one).
    const first = game.matchesPlayed++ % 2 === 0 ? 'player' : 'ai';
    const start = fairLayout(playerDef, aiDef, first);
    game.physics = physics;
    game.pens = {
      player: makePen(physics, 'player', playerDef, start.player.x, start.player.y, start.player.angle),
      ai: makePen(physics, 'ai', aiDef, start.ai.x, start.ai.y, start.ai.angle),
    };
    game.turnNumber = 0;
    game.outcome = null;
    game.effects = [];
    game.shake = 0;

    ui.hudPlayerPen.textContent = playerDef.name;
    ui.hudAiPen.textContent = aiDef.name;
    ui.hudAiName.textContent = `Computer (${AIS[game.settings.difficulty].label})`;
    ui.menu.classList.add('hidden');
    ui.gameover.classList.add('hidden');
    ui.hud.classList.remove('hidden');
    ui.footer.classList.remove('hidden');

    beginTurn(first);
  }

  /** Random starting spots, re-rolled until the first shooter can't simply
      knock the other pen off with the opening shot. Attempts alternate between
      facing rows (player near you, computer at the far side) and the two ends
      of the desk — light pens are almost always knock-out-able in the rows
      layout, but rarely when they start the full desk length apart. */
  function fairLayout(playerDef, aiDef, first) {
    const cx = D.x + D.w / 2;
    const cy = D.y + D.h / 2;
    let layout;
    for (let i = 0; i < AIS.FAIR_START.attempts; i++) {
      if (i % 2 === 0) {
        layout = {
          player: { def: playerDef, x: cx + U.rand(-80, 80), y: D.y + D.h * 0.74, angle: U.rand(-0.35, 0.35) },
          ai: { def: aiDef, x: cx + U.rand(-80, 80), y: D.y + D.h * 0.26, angle: Math.PI + U.rand(-0.35, 0.35) },
        };
      } else {
        const side = U.randSign(); // which end the player starts at
        layout = {
          player: { def: playerDef, x: cx - side * D.w * 0.3, y: cy + U.rand(-90, 90), angle: Math.PI / 2 + U.rand(-0.35, 0.35) },
          ai: { def: aiDef, x: cx + side * D.w * 0.3, y: cy + U.rand(-90, 90), angle: Math.PI / 2 + U.rand(-0.35, 0.35) },
        };
      }
      const [shooter, target] = first === 'player' ? [layout.player, layout.ai] : [layout.ai, layout.player];
      if (!PG.AI.hasOpeningKnockout(shooter, target)) break;
    }
    return layout;
  }

  function beginTurn(who) {
    game.shooter = who;
    game.turnNumber++;
    input.cancel();
    if (who === 'player') {
      setState(STATE.PLAYER_AIM);
      showBanner('Your Turn', 'player');
    } else {
      const snap = (pen) => ({ def: pen.def, x: pen.body.position.x, y: pen.body.position.y, angle: pen.body.angle });
      game.aiTask = PG.AI.createPlanner(game.settings.difficulty, snap(game.pens.ai), snap(game.pens.player));
      setState(STATE.AI_THINK);
      showBanner("Computer's Turn", 'ai');
    }
  }

  function flick(pen, angle, power, offset) {
    game.physics.flick(pen.body, angle, power, offset);
    game.simTime = 0;
    game.settleTicks = 0;
    setState(STATE.SIMULATING);
  }

  /** Detects pens that have tipped off: more than half the pen past the desk edge. */
  function handleFalls() {
    const fallen = [];
    for (const pen of [game.pens.player, game.pens.ai]) {
      if (pen.off || game.physics.isOnDesk(pen.body)) continue;
      const v = game.physics.velocityOf(pen.body);
      pen.off = true;
      pen.fall = {
        t: 0,
        x: pen.body.position.x,
        y: pen.body.position.y,
        angle: pen.body.angle,
        vx: v.x,
        vy: v.y,
        omega: game.physics.angularVelocityOf(pen.body),
      };
      game.physics.removePen(pen.body);
      fallen.push(pen.owner);
    }
    if (!fallen.length || game.state !== STATE.SIMULATING) return;

    // Flicking your own pen off loses immediately (even if both fall together).
    const shooter = game.shooter;
    if (fallen.includes(shooter)) {
      endGame(
        shooter === 'player' ? 'ai' : 'player',
        shooter === 'player' ? 'You flicked your own pen off the desk!' : 'The computer flicked its own pen off the desk!'
      );
    } else {
      endGame(
        shooter,
        shooter === 'player' ? "You knocked the computer's pen off the desk!" : 'The computer knocked your pen off the desk!'
      );
    }
  }

  function endGame(winner, reason) {
    game.outcome = { winner, reason };
    setState(STATE.GAME_OVER);
    const id = game.matchId;
    setTimeout(() => {
      if (game.matchId === id && game.state === STATE.GAME_OVER) showGameOver();
    }, 1400);
  }

  function backToMenu() {
    game.matchId++;
    input.cancel();
    game.pens = null;
    game.physics = null;
    game.effects = [];
    setState(STATE.MENU);
    ui.hud.classList.add('hidden');
    ui.footer.classList.add('hidden');
    ui.gameover.classList.add('hidden');
    ui.menu.classList.remove('hidden');
  }

  /* ---------------- fixed-step simulation ---------------- */

  function fixedTick() {
    if (game.state === STATE.SIMULATING || game.state === STATE.GAME_OVER) {
      game.physics.step();
      handleFalls();
    }
    if (game.state !== STATE.SIMULATING) return;

    // Wait until both pens have essentially stopped moving AND spinning.
    game.simTime += P.TICK_MS;
    const bodies = [game.pens.player, game.pens.ai].filter((p) => !p.off).map((p) => p.body);
    const calm = game.simTime >= P.MIN_SIM_MS && game.physics.isSettled(bodies);
    game.settleTicks = calm ? game.settleTicks + 1 : 0;

    if (game.settleTicks >= P.SETTLE_TICKS || game.simTime >= P.MAX_SIM_MS) {
      bodies.forEach((b) => game.physics.stop(b));
      beginTurn(game.shooter === 'player' ? 'ai' : 'player');
    }
  }

  /* ---------------- per-frame (variable dt) updates ---------------- */

  function update(dt) {
    game.time += dt;
    game.stateTime += dt;

    if (game.state === STATE.AI_THINK) {
      const task = game.aiTask;
      if (!task.done) task.run(AIS.PLAN_BUDGET_MS);
      if (task.done && game.stateTime >= AIS.THINK_MS) {
        game.aiShot = task.result;
        setState(STATE.AI_AIM);
      }
    } else if (game.state === STATE.AI_AIM && game.stateTime >= AIS.AIM_MS) {
      const s = game.aiShot;
      flick(game.pens.ai, s.angle, s.power, s.offset);
    }

    if (game.pens) {
      const k = dt / P.TICK_MS;
      for (const pen of [game.pens.player, game.pens.ai]) {
        const f = pen.fall;
        if (!f || f.t >= 1) continue;
        f.t = Math.min(1, f.t + dt / FALL_MS);
        const drift = k * (1 - f.t * 0.7);
        f.x += f.vx * drift;
        f.y += f.vy * drift;
        f.angle += f.omega * drift;
      }
    }

    for (const e of game.effects) e.age += dt;
    game.effects = game.effects.filter((e) => e.age < e.life);
    game.shake *= Math.exp(-dt / 90);
  }

  function onImpact(hit) {
    if (hit.speed < 0.6) return;
    game.effects.push({
      x: hit.x,
      y: hit.y,
      age: 0,
      life: 420,
      size: 18 + Math.min(40, hit.speed * 3),
      seed: Math.random() * Math.PI,
    });
    game.shake = Math.max(game.shake, Math.min(9, hit.speed * 0.45));
  }

  /* ---------------- scene for the renderer ---------------- */

  function aimWithSpin(pen, aim) {
    const f = game.physics.computeFlick(pen.body, aim.angle, aim.power, aim.offset);
    return Object.assign({}, aim, { pen, omega: f.omega });
  }

  /** The AI "drags" too: an animated pull-back toward its planned power. */
  function aiAimView() {
    const s = game.aiShot;
    const pen = game.pens.ai;
    const b = pen.body;
    const t = U.easeOutCubic(U.clamp(game.stateTime / (AIS.AIM_MS * 0.8), 0, 1));
    const power = s.power * t;
    const grab = {
      x: b.position.x + Math.cos(b.angle) * s.offset,
      y: b.position.y + Math.sin(b.angle) * s.offset,
    };
    const dist = Math.max(power * PG.INPUT.MAX_DRAG_DISTANCE, PG.INPUT.MIN_DRAG_DISTANCE);
    const pointer = { x: grab.x - Math.cos(s.angle) * dist, y: grab.y - Math.sin(s.angle) * dist };
    return aimWithSpin(pen, { angle: s.angle, power, offset: s.offset, grab, pointer, valid: true });
  }

  function buildScene() {
    const pens = game.pens ? [game.pens.ai, game.pens.player] : [];
    let aim = null;
    if (game.state === STATE.PLAYER_AIM) {
      const a = input.getAim();
      if (a) aim = aimWithSpin(game.pens.player, a);
    } else if (game.state === STATE.AI_AIM) {
      aim = aiAimView();
    }
    let active = null;
    if (game.state === STATE.PLAYER_AIM) active = 'player';
    else if (game.state === STATE.AI_THINK || game.state === STATE.AI_AIM) active = 'ai';
    return {
      pens,
      aim,
      active,
      effects: game.effects,
      shake: game.shake,
      time: game.time,
      showLabels: game.state !== STATE.SIMULATING && game.state !== STATE.MENU,
    };
  }

  /* ---------------- main loop ---------------- */

  let last = performance.now();
  let acc = 0;
  function frame(now) {
    const dt = Math.min(now - last, 100);
    last = now;
    acc += dt;
    let ticks = 0;
    while (acc >= P.TICK_MS && ticks < 6) {
      fixedTick();
      acc -= P.TICK_MS;
      ticks++;
    }
    if (ticks === 6) acc = 0; // tab was in the background — don't spiral
    update(dt);
    renderer.render(buildScene());
    requestAnimationFrame(frame);
  }

  /* ---------------- HUD / overlays ---------------- */

  function updateHud() {
    const s = game.state;
    const pill = ui.pill;
    if (s === STATE.GAME_OVER) {
      pill.className = 'turn-pill over';
      pill.textContent = game.outcome && game.outcome.winner === 'player' ? 'You Win!' : 'Computer Wins';
      ui.status.textContent = game.outcome ? game.outcome.reason : '';
      return;
    }
    const mine = game.shooter === 'player';
    pill.className = 'turn-pill ' + (mine ? 'player' : 'ai');
    pill.textContent = mine ? 'Your Turn' : "Computer's Turn";
    ui.status.textContent =
      {
        [STATE.PLAYER_AIM]: 'Press on your pen, drag backwards and release to flick · Esc cancels',
        [STATE.AI_THINK]: 'The computer is thinking…',
        [STATE.AI_AIM]: 'The computer is lining up its shot…',
        [STATE.SIMULATING]: 'Waiting for both pens to stop…',
      }[s] || '';
  }

  function showBanner(text, cls) {
    const el = ui.banner;
    el.textContent = text;
    el.className = 'turn-banner ' + cls;
    void el.offsetWidth; // restart the CSS animation
    el.classList.add('show');
  }

  function showGameOver() {
    const won = game.outcome.winner === 'player';
    ui.goTitle.textContent = won ? `You Win, ${NAME}!` : `Unlucky, ${NAME}!`;
    ui.goTitle.className = 'title ' + (won ? 'win' : 'lose');
    ui.goReason.textContent = game.outcome.reason;
    ui.goStats.textContent =
      `${game.pens.player.def.name} vs ${game.pens.ai.def.name} · ` +
      `${AIS[game.settings.difficulty].label} AI · ${game.turnNumber} turn${game.turnNumber === 1 ? '' : 's'}`;
    ui.gameover.classList.remove('hidden');
  }

  /* ---------------- menu ---------------- */

  function buildMenu() {
    const pens = PG.PEN_ORDER.map((id) => PG.PENS[id]);
    const maxOf = (k) => Math.max(...pens.map((p) => p[k]));
    const maxRange = Math.max(...pens.map((p) => PG.PhysicsModel.slideDistance(p, PG.PhysicsModel.maxLaunchSpeed(p))));
    const bar = (label, frac) =>
      `<div class="stat"><span>${label}</span><div class="bar"><i style="width:${Math.round(
        U.clamp(frac, 0.06, 1) * 100
      )}%"></i></div></div>`;

    for (const def of pens) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'pen-card';
      card.dataset.pen = def.id;
      const range = PG.PhysicsModel.slideDistance(def, PG.PhysicsModel.maxLaunchSpeed(def));
      card.innerHTML =
        `<canvas class="pen-preview" width="480" height="110"></canvas>` +
        `<div class="pen-name">${def.name}</div>` +
        `<div class="pen-tag">${def.tagline}</div>` +
        bar('Mass', def.mass / maxOf('mass')) +
        bar('Desk friction', def.frictionAir / maxOf('frictionAir')) +
        bar('Bounciness', def.restitution / maxOf('restitution')) +
        bar('Slide range', range / maxRange);
      card.addEventListener('click', () => selectPen(def.id));
      ui.penCards.appendChild(card);
      renderer.drawPenPreview(card.querySelector('canvas'), def, PG.COLORWAYS.player);
    }

    for (const key of ['easy', 'medium', 'hard']) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'diff';
      b.dataset.diff = key;
      b.textContent = AIS[key].label;
      b.addEventListener('click', () => selectDifficulty(key));
      ui.diffRow.appendChild(b);
    }

    selectPen(game.settings.penId);
    selectDifficulty(game.settings.difficulty);
  }

  function selectPen(id) {
    game.settings.penId = id;
    ui.penCards.querySelectorAll('.pen-card').forEach((c) => c.classList.toggle('selected', c.dataset.pen === id));
  }

  function selectDifficulty(key) {
    game.settings.difficulty = key;
    ui.diffRow.querySelectorAll('.diff').forEach((b) => b.classList.toggle('selected', b.dataset.diff === key));
    ui.diffDesc.textContent = AIS[key].description;
  }

  ui.greeting.textContent = `Welcome back, ${NAME}`;
  ui.hudPlayerName.textContent = NAME;

  ui.btnStart.addEventListener('click', startMatch);
  ui.btnAgain.addEventListener('click', startMatch);
  ui.btnSetup.addEventListener('click', backToMenu);
  ui.btnMenu.addEventListener('click', backToMenu);

  // Redraw menu previews once the web font has loaded (label text on the marker).
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
      ui.penCards.querySelectorAll('.pen-card').forEach((c) =>
        renderer.drawPenPreview(c.querySelector('canvas'), PG.PENS[c.dataset.pen], PG.COLORWAYS.player)
      );
    });
  }

  buildMenu();
  requestAnimationFrame(frame);

  // Handy for tweaking from the dev-tools console, e.g. PenGame.debug.game
  PG.debug = { game, STATE };
})((window.PenGame = window.PenGame || {}));
