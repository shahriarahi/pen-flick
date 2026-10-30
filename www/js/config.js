/* ==========================================================================
   config.js — EVERY tunable number in the game lives here.

   Units used throughout:
     • distance  : "world units" (the logical world is 1280 x 800; the canvas is
                   scaled to fit the window, so 1 unit ≈ 1 CSS pixel at 100%).
     • velocity  : world units per 16.67 ms (one 60 Hz frame). This is Matter.js's
                   native velocity unit, so a speed of 10 means "10 units per frame".
     • mass      : Matter.js mass units (arbitrary; only RATIOS between pens matter
                   for collisions, but mass also divides the flick impulse — see
                   powerScale below).
   ========================================================================== */
(function (PG) {
  'use strict';

  // The human player's name, shown in the menu, HUD, pen tag and results.
  PG.PLAYER_NAME = 'Rahi';

  /* ------------------------------------------------------------------------
     World / desk geometry
     ------------------------------------------------------------------------ */
  PG.VIEW = { width: 1280, height: 800 };

  // The desk is the playable surface; a pen falls off once its centre (more
  // than half of the pen) crosses one of its four edges. A thin strip of floor is drawn around it so you can watch
  // a pen tumble off. Set DESK_MARGIN to 0 to make the desk edges exactly the
  // canvas edges.
  const DESK_MARGIN = 60;
  PG.DESK = {
    x: DESK_MARGIN,
    y: DESK_MARGIN,
    w: PG.VIEW.width - DESK_MARGIN * 2,
    h: PG.VIEW.height - DESK_MARGIN * 2,
  };

  /* ------------------------------------------------------------------------
     Global physics tuning (Matter.js engine)
     ------------------------------------------------------------------------ */
  PG.PHYSICS = {
    // Fixed simulation tick. The game loop always advances physics in exact
    // 16.67 ms ticks (never by a variable frame delta) so the simulation is
    // deterministic — the Hard AI relies on this to "rehearse" shots.
    TICK_MS: 1000 / 60,

    // Each tick is split into this many Matter.js sub-steps. Thin, fast pens can
    // "tunnel" through each other if they move further than their own width in
    // one step; sub-stepping prevents that. Higher = more accurate + more CPU.
    SUBSTEPS: 3,

    // Matter.js constraint-solver iterations (defaults are 6 and 4). Higher
    // values make pen-on-pen contacts stiffer and more accurate.
    POSITION_ITERATIONS: 10,
    VELOCITY_ITERATIONS: 8,

    // The impulse (mass x velocity) a 100%-power flick delivers to a pen whose
    // powerScale is 1.0. Launch speed = impulse * powerScale / mass.
    // ▲ raise to make every pen fly further, ▼ lower for a more delicate game.
    MAX_FLICK_IMPULSE: 75,

    // How much spin you get when you grab the pen away from its centre.
    // Spin = (lever arm x impulse) / moment of inertia * SPIN_FACTOR.
    // 0 disables spin completely; 1 is physically "correct" for Matter's bodies.
    SPIN_FACTOR: 1.0,

    // Matter.js deliberately inflates every body's rotational inertia by 4x for
    // stability. Multiply it further here: < 1 makes pens spin more freely
    // (both from flicks and collisions), > 1 makes them resist rotation.
    INERTIA_MULTIPLIER: 1.0,

    // ---- Turn hand-off: "have both pens stopped?" -------------------------
    // A pen counts as stopped when its speed AND angular speed are below these
    // tiny thresholds for SETTLE_TICKS consecutive ticks.
    SETTLE_SPEED: 0.05, // units / frame
    SETTLE_ANGULAR_SPEED: 0.0015, // radians / frame
    SETTLE_TICKS: 15, // ~0.25 s of continuous calm
    MIN_SIM_MS: 300, // never hand over the turn sooner than this
    MAX_SIM_MS: 15000, // safety valve: force-stop pens after 15 s
  };

  /* ------------------------------------------------------------------------
     Player input
     ------------------------------------------------------------------------ */
  PG.INPUT = {
    GRAB_TOLERANCE: 26, // how far outside the pen outline a press still "grabs" it
    TOUCH_TARGET_PX: 48, // fingers: the grab strip across a pen is at least this wide on screen (Android's 48dp guideline)
    MAX_DRAG_DISTANCE: 230, // drag length (world units) that equals 100% power
    MIN_DRAG_DISTANCE: 12, // shorter drags are treated as a cancelled shot
  };

  /* ------------------------------------------------------------------------
     PEN DEFINITIONS — the heart of the tuning.

     Every pen is a Matter.js rectangle body (length x width, rounded corners).
     Because the game is TOP-DOWN with gravity switched off, there is no
     "floor" body for the pen to rub against. Instead:

       frictionAir    → THE DESK. Matter multiplies velocity by
                        (1 - frictionAir) every frame, so this is how quickly
                        a sliding pen bleeds off speed. Approximate slide
                        distance from launch speed v ≈ v / frictionAir.
                        0.02 = slides far (ice-like), 0.06 = stops quickly.
                        It also damps spinning.

       friction       → pen-against-pen RUBBING (0..1). When two pens touch,
                        Matter uses the LOWER of the two values. High friction
                        makes glancing hits grab and spin the other pen.

       frictionStatic → how "sticky" two resting pens are before sliding
                        against each other (Matter default 0.5).

       restitution    → BOUNCINESS of pen-on-pen hits (0 = dead thud,
                        1 = perfectly elastic). Matter uses the HIGHER of the
                        two pens' values for a collision.

       mass           → heavier pens shove lighter ones further and are hard to
                        push. Set explicitly with Body.setMass() (Matter's
                        `mass` option is ignored at creation time — it derives
                        mass from density x area unless you call setMass).

       powerScale     → multiplies the flick impulse for THIS pen. Physically,
                        a heavy pen launched with the same finger impulse moves
                        slower (v = impulse / mass); powerScale lets a heavy pen
                        still reach across the desk while keeping its
                        momentum advantage in collisions.
                        Max launch speed = MAX_FLICK_IMPULSE * powerScale / mass.

       length / width → collision shape AND drawn size (world units).
     ------------------------------------------------------------------------ */
  PG.PENS = {
    ballpoint: {
      id: 'ballpoint',
      name: 'Standard Ballpoint',
      tagline: 'Balanced all-rounder. Predictable slides, honest bounces.',
      style: 'ballpoint', // which drawing routine renderer.js uses
      length: 170,
      width: 14,

      mass: 3.0, // balanced
      frictionAir: 0.03, // medium desk drag → ~25/0.03 ≈ 800 units at full power
      friction: 0.3, // medium pen-on-pen grip
      frictionStatic: 0.5,
      restitution: 0.45, // medium bounce
      powerScale: 1.0, // max launch speed = 75 * 1.0 / 3.0 = 25 units/frame
    },

    fountain: {
      id: 'fountain',
      name: 'Heavy Fountain Pen',
      tagline: 'Hits like a truck and barely budges — but stops quickly.',
      style: 'fountain',
      length: 180,
      width: 22, // visually thicker

      mass: 5.5, // HIGH mass: wins momentum battles, hard to push off
      frictionAir: 0.05, // HIGH desk drag → stops quickly (~460 units at full power)
      friction: 0.6, // grippy lacquer
      frictionStatic: 0.8,
      restitution: 0.15, // LOW bounce: dead, heavy thud
      powerScale: 1.7, // max launch speed = 75 * 1.7 / 5.5 ≈ 23 units/frame
    },

    marker: {
      id: 'marker',
      name: 'Lightweight Marker',
      tagline: 'Slides forever and bounces wildly. Easy to overshoot!',
      style: 'marker',
      length: 160,
      width: 28, // visually wider

      mass: 2.0, // LOW mass: gets knocked around easily
      frictionAir: 0.02, // LOW desk drag → slides far (~1300 units at full power)
      friction: 0.1, // slick plastic
      frictionStatic: 0.2,
      restitution: 0.75, // HIGH bounce
      powerScale: 0.7, // max launch speed = 75 * 0.7 / 2.0 ≈ 26 units/frame
    },

    gel: {
      id: 'gel',
      name: 'Clicky Gel Pen',
      tagline: 'Rubber-gripped and lively. Grabs grippy pens on contact.',
      style: 'gel',
      length: 165,
      width: 15,

      mass: 2.6, // a touch lighter than the ballpoint
      frictionAir: 0.04, // rubber drags on the desk → ~680 units at full power
      friction: 0.8, // VERY grippy rubber… but Matter uses the LOWER of the two
      //                pens' values, so the grip only shows against grippy
      //                opponents (e.g. the fountain pen's 0.6)
      frictionStatic: 0.9,
      restitution: 0.55, // springy
      powerScale: 0.95, // max launch speed = 75 * 0.95 / 2.6 ≈ 27 units/frame
    },

    pencil: {
      id: 'pencil',
      name: 'Wooden Pencil',
      tagline: 'Featherweight and fast. Easy to flick, easy to bully.',
      style: 'pencil',
      length: 176,
      width: 12, // slimmest body: hardest target to hit squarely

      mass: 1.5, // LIGHTEST pen: any solid hit sends it flying
      frictionAir: 0.026, // painted wood glides → ~1050 units at full power
      friction: 0.35,
      frictionStatic: 0.5,
      restitution: 0.3, // wood absorbs impacts: a dull "tock"
      powerScale: 0.55, // max launch speed = 75 * 0.55 / 1.5 ≈ 27.5 units/frame
    },

    tactical: {
      id: 'tactical',
      name: 'Tactical Metal Pen',
      tagline: 'Machined-steel heavyweight. Short range, nearly impossible to budge.',
      style: 'tactical',
      length: 160,
      width: 18,

      mass: 7.5, // HEAVIEST pen: dominates every momentum exchange
      frictionAir: 0.045, // heavy drag → ~500 units at full power
      friction: 0.2, // smooth anodised metal slides off other pens
      frictionStatic: 0.3,
      restitution: 0.25, // solid, dead impact
      powerScale: 2.3, // max launch speed = 75 * 2.3 / 7.5 = 23 units/frame
    },
  };

  // Order of the cards in the menu (the computer also picks its pen from this list).
  PG.PEN_ORDER = ['ballpoint', 'fountain', 'marker', 'gel', 'pencil', 'tactical'];

  /* Colour schemes: the player's pen is blue, the computer's is red. */
  PG.COLORWAYS = {
    player: {
      primary: '#2f6fe0',
      ink: '#1b3d9c',
      lacquer: '#1d3260',
      accent: '#5c9bff',
      glow: 'rgba(92,155,255,0.95)',
    },
    ai: {
      primary: '#d83a3a',
      ink: '#8c1616',
      lacquer: '#5e1724',
      accent: '#ff6b6b',
      glow: 'rgba(255,107,107,0.95)',
    },
  };

  /* ------------------------------------------------------------------------
     AI opponent
     ------------------------------------------------------------------------ */
  PG.AI_SETTINGS = {
    THINK_MS: 850, // minimum "thinking" pause before the AI starts aiming
    AIM_MS: 1000, // how long the AI's drag/power animation plays before release
    PLAN_BUDGET_MS: 10, // per-frame CPU budget for the Hard AI's shot rehearsals
    SIM_MAX_TICKS: 720, // longest rehearsal (12 s of simulated time)

    // Fair start: a new match re-rolls the starting layout (up to `attempts`
    // times) until whoever shoots first has no knock-out on the opening shot.
    FAIR_START: {
      attempts: 12,
      rehearsals: 250, // previews per layout check (it stops early once it finds a knock-out)
      search: null, // null = check with the same shot search the Hard AI uses
      budgetMs: 25, // per-frame CPU budget for these checks (nothing moves yet, so it can use more of each frame)
    },

    easy: {
      label: 'Easy',
      description:
        'Aims roughly at your pen (up to 12° off) with a hit-or-miss force. Rarely throws its own pen away.',
      maxAngleErrorDeg: 12,
      powerMin: 0.8, // force = (force needed to reach you) x random 0.8…1.8
      powerMax: 1.8,
      arrivalSpeed: 3,
      grabOffsetFraction: 0.3, // grabs off-centre → accidental spin
    },

    medium: {
      label: 'Medium',
      description:
        'Rehearses a handful of shots to find a knock-out, otherwise plays a safe push — but its hand wobbles a little.',
      maxRehearsals: 120, // physics previews per turn
      search: { maxAngleDeg: 8, angleStepDeg: 4, grabOffsets: [0], powerStep: 0.08, refineIterations: 3 },
      aimNoiseDeg: 1.5, // the "wobble": random angle error of up to ±1.5°…
      powerNoise: 0.08, // …and ±8% force error on the chosen shot
      exitMargin: 12,
      edgeSafetyMargin: 15,
      attackWeight: 0.3, // how much it values setting up its next knock-out vs. staying safe
    },

    hard: {
      label: 'Hard',
      description:
        'Searches angled and spinning shots for a knock-out. If there is none, it picks the spot where you can’t knock it off.',
      maxRehearsals: 450, // physics previews for its own shot each turn
      // Knock-out search: directions up to ±24° from the centre line (3° steps),
      // grabbed at the centre and halfway to either end (spin), force in 6% steps.
      search: { maxAngleDeg: 24, angleStepDeg: 3, grabOffsets: [0, -0.5, 0.5], powerStep: 0.06, refineIterations: 4 },
      exitMargin: 12, // aim to push your pen's centre this far past the edge (it falls once the centre crosses)
      edgeSafetyMargin: 15, // its own pen must finish at least this far from any edge
      attackWeight: 0.3, // how much it values setting up its next knock-out vs. staying safe
      retreatPowers: [0.15, 0.3, 0.45, 0.6], // extra "back off toward the middle" shots it considers
      replyCandidates: 10, // best positions checked against your possible replies…
      replyRehearsals: 160, // …each with up to this many previews of your shots
      reply: null, // null = imagine your replies with the same search it uses for its own shots
    },
  };
})((window.PenGame = window.PenGame || {}));
