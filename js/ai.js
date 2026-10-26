/* ==========================================================================
   ai.js — the computer opponent.

   PG.AI.createPlanner(difficulty, aiSnap, playerSnap) returns a small task
   object. main.js calls task.run(budgetMs) once per frame until task.done,
   then reads task.result = { angle, power (0..1), offset }. Easy and Medium
   finish instantly; Hard runs many physics rehearsals spread across frames so
   the game never stutters.

   A "snap" is a frozen copy of a pen: { def, x, y, angle }.
   ========================================================================== */
(function (PG) {
  'use strict';

  const U = PG.util;
  const D = PG.DESK;
  const M = PG.PhysicsModel;

  /* ---------------- geometry helpers ---------------- */

  function aimAt(a, p) {
    const dx = p.x - a.x;
    const dy = p.y - a.y;
    const dist = Math.hypot(dx, dy) || 1;
    return { angle: Math.atan2(dy, dx), dist, ux: dx / dist, uy: dy / dist };
  }

  /** Half-extent of a pen's rectangle measured along direction (ux, uy). */
  function supportExtent(snap, ux, uy) {
    const ax = Math.cos(snap.angle);
    const ay = Math.sin(snap.angle);
    return (
      (snap.def.length / 2) * Math.abs(ux * ax + uy * ay) +
      (snap.def.width / 2) * Math.abs(-ux * ay + uy * ax)
    );
  }

  /** Distance from (x, y) along (ux, uy) until the ray leaves the desk. */
  function rayToDeskEdge(x, y, ux, uy) {
    let t = Infinity;
    if (ux > 1e-9) t = Math.min(t, (D.x + D.w - x) / ux);
    if (ux < -1e-9) t = Math.min(t, (D.x - x) / ux);
    if (uy > 1e-9) t = Math.min(t, (D.y + D.h - y) / uy);
    if (uy < -1e-9) t = Math.min(t, (D.y - y) / uy);
    return Math.max(0, t);
  }

  /** How far the AI pen travels before its front face meets the player's pen. */
  function contactGap(a, p, aim) {
    return Math.max(0, aim.dist - supportExtent(a, aim.ux, aim.uy) - supportExtent(p, aim.ux, aim.uy));
  }

  /** Power needed to cover `gap` and still be moving at `arrivalSpeed`. */
  function powerToReach(a, gap, arrivalSpeed) {
    return (M.decelPerUnit(a.def) * gap + arrivalSpeed) / M.maxLaunchSpeed(a.def);
  }

  /* ---------------- EASY ----------------
     General direction ± up to 20°, highly randomised force, sloppy grab. */
  function planEasy(a, p, cfg) {
    const aim = aimAt(a, p);
    const err = U.rand(-cfg.maxAngleErrorDeg, cfg.maxAngleErrorDeg);
    return {
      angle: aim.angle + U.deg2rad(err),
      power: U.rand(cfg.powerMin, cfg.powerMax),
      offset: U.rand(-1, 1) * cfg.grabOffsetFraction * (a.def.length / 2),
      note: `easy: ${err.toFixed(1)}° off target`,
    };
  }

  /* ---------------- MEDIUM ----------------
     Exact angle, then a deliberate 1–5° miss; moderate force that is at
     least enough to reach the target. */
  function planMedium(a, p, cfg) {
    const aim = aimAt(a, p);
    const err = U.rand(cfg.minAngleErrorDeg, cfg.maxAngleErrorDeg) * U.randSign();
    const reach = powerToReach(a, contactGap(a, p, aim), cfg.arrivalSpeed);
    const power = U.clamp(Math.max(reach, U.rand(cfg.powerMin, cfg.powerMax)), 0.2, cfg.powerCap);
    return {
      angle: aim.angle + U.deg2rad(err),
      power,
      offset: U.rand(-1, 1) * cfg.grabOffsetFraction * (a.def.length / 2),
      note: `medium: ${err.toFixed(1)}° off target`,
    };
  }

  /* ---------------- HARD ----------------
     1) Perfect centre-of-mass vector: aim straight through the player's
        centre and grab the AI pen dead-centre (no spin, so it stays on line).
     2) Analytic estimate of the exact force, from momentum + friction:
          a. The player's pen must slide  s = (distance to edge along the shot)
             + (its own half-extent) + margin  to be completely off the desk.
             With linear drag that needs a post-impact speed  vP' = κP · s.
          b. 1-D collision with restitution e (Matter uses max(eA, eB)):
                vP' = (1 + e) · mA / (mA + mP) · vImpact
          c. Friction on the way in: v0 = vImpact + κA · gap.
          d. After impact the AI pen keeps  vA' = (mA − e·mP)/(mA + mP) · vImpact,
             so it slides  vA'/κA  further — this must stay on the desk.
     3) Verify & refine by rehearsing shots in a scratch Matter.js world (the
        real simulation is deterministic, so a rehearsal is a faithful
        preview), then binary-search the minimum force that knocks the player
        off while the AI pen finishes safely away from every edge. */
  function analyticEstimate(a, p, aim, cfg) {
    const kA = M.decelPerUnit(a.def);
    const extA = supportExtent(a, aim.ux, aim.uy);
    const extP = supportExtent(p, aim.ux, aim.uy);
    const gap = contactGap(a, p, aim);
    const exitDist = rayToDeskEdge(p.x, p.y, aim.ux, aim.uy) + extP + cfg.exitMargin;
    const vP = M.speedForDistance(p.def, exitDist);
    const e = Math.max(a.def.restitution, p.def.restitution);
    const mA = a.def.mass;
    const mP = p.def.mass;
    const vImpact = (vP * (mA + mP)) / ((1 + e) * mA);
    const v0 = vImpact + kA * gap;
    const vAafter = (vImpact * (mA - e * mP)) / (mA + mP);
    const aiSlide = vAafter > 0 ? vAafter / kA : 0;
    const cx = a.x + aim.ux * gap;
    const cy = a.y + aim.uy * gap;
    const aiRoom = rayToDeskEdge(cx, cy, aim.ux, aim.uy) - extA;
    return {
      power: v0 / M.maxLaunchSpeed(a.def),
      gap,
      exitDist,
      vImpact,
      v0,
      aiSlide,
      aiRoom,
      aiSafe: aiSlide < aiRoom - cfg.edgeSafetyMargin,
    };
  }

  /** Plays a candidate shot in a throw-away physics world and reports the outcome. */
  function rehearse(a, p, shot) {
    const sim = PG.createPhysics();
    const aiBody = sim.addPen(a.def, a.x, a.y, a.angle, 'ai');
    const plBody = sim.addPen(p.def, p.x, p.y, p.angle, 'player');
    sim.flick(aiBody, shot.angle, shot.power, shot.offset);

    let playerOff = false;
    let aiOff = false;
    let calm = 0;
    const maxTicks = PG.AI_SETTINGS.SIM_MAX_TICKS;
    for (let t = 0; t < maxTicks; t++) {
      sim.step();
      if (!sim.isOnDesk(aiBody)) {
        aiOff = true;
        break;
      }
      if (!playerOff && !sim.isOnDesk(plBody)) {
        playerOff = true;
        sim.removePen(plBody);
      }
      calm = sim.isSettled(playerOff ? [aiBody] : [aiBody, plBody]) ? calm + 1 : 0;
      if (calm >= PG.PHYSICS.SETTLE_TICKS) break;
    }
    return {
      power: shot.power,
      playerOff,
      aiOff,
      aiEdge: sim.edgeClearance(aiBody),
      playerEdge: playerOff ? -Infinity : sim.edgeClearance(plBody),
    };
  }

  function* planHard(a, p, cfg) {
    const aim = aimAt(a, p);
    const est = analyticEstimate(a, p, aim, cfg);
    const results = new Map();
    const success = (r) => r.playerOff && !r.aiOff && r.aiEdge >= cfg.edgeSafetyMargin;

    function* trial(power) {
      const key = Math.round(U.clamp(power, 0.02, 1) * 1000) / 1000;
      if (!results.has(key)) {
        results.set(key, rehearse(a, p, { angle: aim.angle, power: key, offset: 0 }));
        yield; // let the frame breathe between rehearsals
      }
      return results.get(key);
    }

    // Rehearse around the analytic estimate, then sweep the whole power range.
    // (Rotation and off-axis contact absorb some momentum, so the 1-D estimate
    // is a starting point; the rehearsals provide the exact answer.)
    const seeds = [est.power * 0.9, est.power, est.power * 1.1, est.power * 1.25];
    for (let s = cfg.sweepMin; s <= 1.0001; s += cfg.sweepStep) seeds.push(s);
    for (const s of seeds) if (s > 0 && s <= 1) yield* trial(s);

    const sorted = () => [...results.values()].sort((x, y) => x.power - y.power);
    let list = sorted();
    const firstOk = list.findIndex(success);

    let chosen;
    if (firstOk >= 0) {
      // Binary-search the minimum force that still works.
      let hi = list[firstOk].power;
      let lo = firstOk > 0 ? list[firstOk - 1].power : 0.02;
      for (let i = 0; i < cfg.refineIterations; i++) {
        const mid = (lo + hi) / 2;
        const r = yield* trial(mid);
        if (success(r)) hi = r.power;
        else lo = mid;
      }
      // A small cushion for robustness — only if it is still a safe win.
      const cushioned = yield* trial(hi * (1 + cfg.forceCushion));
      chosen = success(cushioned) ? cushioned : results.get(Math.round(hi * 1000) / 1000);
    } else {
      // No winning shot exists along the centre line (too far / too risky):
      // pick the shot that leaves the player's pen closest to an edge while
      // its own pen stays well clear of every edge (ready for next turn).
      const all = sorted().filter((r) => !r.aiOff);
      const safe = all.filter((r) => r.aiEdge >= cfg.fallbackSafety);
      if (safe.length) chosen = safe.reduce((best, r) => (r.playerEdge < best.playerEdge ? r : best));
      else if (all.length) chosen = all.reduce((best, r) => (r.aiEdge > best.aiEdge ? r : best));
      else chosen = { power: U.clamp(est.power * 0.5, 0.15, 0.6) };
    }

    console.info('[AI hard]', {
      analyticPower: +est.power.toFixed(3),
      analyticSaysSafe: est.aiSafe,
      chosenPower: +chosen.power.toFixed(3),
      expectedWin: !!chosen.playerOff,
      rehearsals: results.size,
    });

    return {
      angle: aim.angle,
      power: chosen.power,
      offset: 0,
      note: chosen.playerOff ? 'hard: calculated knock-out' : 'hard: best positional push',
    };
  }

  /* ---------------- public API ---------------- */

  PG.AI = {
    createPlanner(difficulty, aiSnap, playerSnap) {
      const cfg = PG.AI_SETTINGS[difficulty];
      const gen =
        difficulty === 'hard'
          ? planHard(aiSnap, playerSnap, cfg)
          : (function* () {
              return difficulty === 'easy' ? planEasy(aiSnap, playerSnap, cfg) : planMedium(aiSnap, playerSnap, cfg);
            })();

      const task = {
        done: false,
        result: null,
        run(budgetMs) {
          const t0 = performance.now();
          while (!task.done) {
            const r = gen.next();
            if (r.done) {
              task.done = true;
              task.result = r.value;
              break;
            }
            if (performance.now() - t0 > budgetMs) break;
          }
        },
      };
      return task;
    },

    // Exposed for tuning / debugging from the browser console.
    _internals: { aimAt, supportExtent, rayToDeskEdge, contactGap, analyticEstimate, rehearse },
  };
})((window.PenGame = window.PenGame || {}));
