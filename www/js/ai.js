/* ==========================================================================
   ai.js — the computer opponent.

   PG.AI.createPlanner(difficulty, aiSnap, playerSnap) returns a small task
   object. main.js calls task.run(budgetMs) once per frame until task.done,
   then reads task.result = { angle, power (0..1), offset }. Easy finishes
   instantly; Medium and Hard run physics rehearsals spread across frames so
   the game never stutters. The fair-start check at the beginning of a match
   runs the same way (PG.AI.createTask + PG.AI.hasOpeningKnockout).

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

  /** Shot directions worth trying: the centre line first, then fanning out to
      either side — but only as far as the AI pen could still clip the target. */
  function fanAngles(a, p, aim, maxDevDeg, stepDeg) {
    const reach = (a.def.length + p.def.length) / 2;
    const dev = Math.min(maxDevDeg, U.rad2deg(Math.asin(Math.min(1, reach / aim.dist))));
    const out = [aim.angle];
    for (let d = stepDeg; d <= dev + 1e-9; d += stepDeg) out.push(aim.angle + U.deg2rad(d), aim.angle - U.deg2rad(d));
    return out;
  }

  /* ---------------- the analytic model ----------------
     Estimate of the force a straight centre-of-mass shot needs, from
     momentum + friction:
       a. The target falls once its centre crosses the edge, so it must slide
          s = (distance from its centre to the edge along the shot) + margin.
          With linear drag that needs a post-impact speed  vP' = κP · s.
       b. 1-D collision with restitution e (Matter uses max(eA, eB)):
             vP' = (1 + e) · mA / (mA + mP) · vImpact
       c. Friction on the way in: v0 = vImpact + κA · gap.
       d. After impact the shooter keeps  vA' = (mA − e·mP)/(mA + mP) · vImpact,
          so it slides  vA'/κA  further — this must stay on the desk.
     It ignores spin and off-axis contact, so the AI only uses it to seed
     rehearsals and to judge how dangerous a position is. */
  function analyticEstimate(a, p, aim, cfg) {
    const kA = M.decelPerUnit(a.def);
    const extA = supportExtent(a, aim.ux, aim.uy);
    const gap = contactGap(a, p, aim);
    const exitDist = rayToDeskEdge(p.x, p.y, aim.ux, aim.uy) + cfg.exitMargin;
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

  /** Force a straight shot from `shooter` would need to knock `target` off (> 1 = out of reach). */
  function knockoutForce(shooter, target, cfg) {
    return analyticEstimate(shooter, target, aimAt(shooter, target), cfg).power;
  }

  /* ---------------- rehearsals ---------------- */

  const snapOf = (body, def) => ({ def, x: body.position.x, y: body.position.y, angle: body.angle });

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
      shot,
      power: shot.power,
      playerOff,
      aiOff,
      touched: playerOff || Math.hypot(plBody.position.x - p.x, plBody.position.y - p.y) > 0.5,
      aiEdge: sim.edgeClearance(aiBody),
      playerEdge: playerOff ? -Infinity : sim.edgeClearance(plBody),
      ai: aiOff ? null : snapOf(aiBody, a.def),
      player: playerOff ? null : snapOf(plBody, p.def),
    };
  }

  /** A shooter-vs-target search with a fixed rehearsal budget (machine-independent). */
  function createSearch(a, p, cfg, budget) {
    return { a, p, cfg, left: budget, results: [] };
  }

  function* trial(s, shot) {
    if (s.left <= 0) return null;
    s.left--;
    const r = rehearse(s.a, s.p, shot);
    s.results.push(r);
    yield; // let the frame breathe between rehearsals
    return r;
  }

  const isWin = (r, cfg) => r.playerOff && !r.aiOff && r.aiEdge >= cfg.edgeSafetyMargin;

  /**
   * Looks for shots that knock the target off. For every direction × grab
   * point it first fires one full-power probe (a line that never touches the
   * target is dropped), then sweeps the force upward and keeps the weakest
   * shot that wins. If the sweep jumps straight from "not enough" to "own pen
   * flies off", it bisects that gap — the winning window can be narrow.
   */
  function* knockoutSearch(s, opts) {
    const { a, p, cfg } = s;
    const aim = aimAt(a, p);
    const start = U.clamp(powerToReach(a, contactGap(a, p, aim), 0) * 0.9, 0.05, 1);
    const wins = [];

    for (const angle of fanAngles(a, p, aim, opts.maxAngleDeg, opts.angleStepDeg)) {
      for (const grab of opts.grabOffsets) {
        const offset = grab * (a.def.length / 2);
        const probe = yield* trial(s, { angle, power: 1, offset });
        if (!probe) return wins; // out of budget
        if (!probe.touched) continue;

        let lastShort = null;
        let won = null;
        for (let power = start; power < 1 && !won; power += opts.powerStep) {
          const r = yield* trial(s, { angle, power, offset });
          if (!r) return wins;
          if (isWin(r, cfg)) won = r;
          else if (r.aiOff || r.playerOff) break; // too much force from here on
          else lastShort = r;
        }
        if (!won && isWin(probe, cfg)) won = probe;

        if (!won && lastShort) {
          let lo = lastShort.power;
          let hi = Math.min(1, lo + opts.powerStep);
          for (let i = 0; i < opts.refineIterations && !won; i++) {
            const mid = (lo + hi) / 2;
            const r = yield* trial(s, { angle, power: mid, offset });
            if (!r) return wins;
            if (isWin(r, cfg)) won = r;
            else if (r.aiOff || r.playerOff) hi = mid;
            else lo = mid;
          }
        }
        if (won) {
          wins.push(won);
          if (opts.stopAtFirst) return wins;
        }
      }
    }
    return wins;
  }

  /** The winning shot that leaves the AI's own pen furthest from any edge. */
  function bestWin(wins) {
    return wins.reduce((best, r) => (r.aiEdge > best.aiEdge ? r : best));
  }

  /**
   * How good is a position where nobody fell off? High when the player would
   * need a lot of force to knock the AI's pen off, and when the AI's next
   * knock-out would need little force. Its own pen's edge clearance breaks ties.
   */
  function positionScore(r, cfg) {
    const danger = knockoutForce(r.player, r.ai, cfg);
    const chance = knockoutForce(r.ai, r.player, cfg);
    return Math.min(danger, 1.5) - cfg.attackWeight * Math.min(chance, 1.5) + Math.min(r.aiEdge, 150) / 300;
  }

  function positionalCandidates(results, cfg) {
    return results
      .filter((r) => !r.aiOff && !r.playerOff && r.aiEdge >= cfg.edgeSafetyMargin)
      .map((r) => ({ r, score: positionScore(r, cfg) }))
      .sort((x, y) => y.score - x.score);
  }

  /** Could `shooter` knock `target` off with a straight-ish shot? (A human doesn't
      care how close to the edge their own pen finishes, hence the zero margin.) */
  function* hasKnockout(shooter, target, cfg, budget, opts) {
    const s = createSearch(shooter, target, { ...cfg, edgeSafetyMargin: 0 }, budget);
    const wins = yield* knockoutSearch(s, { ...opts, stopAtFirst: true });
    return wins.length > 0;
  }

  /** Could the player knock the AI's pen off from the position rehearsal `r` ends in? */
  function* playerHasReply(r, cfg) {
    return yield* hasKnockout(r.player, r.ai, cfg, cfg.replyRehearsals, cfg.reply || cfg.search);
  }

  /* ---------------- EASY ----------------
     Rough aim (up to ±12° off), a force somewhere around what it takes to
     reach you, and a sloppy grab. It does check one thing: if a rehearsal
     shows the shot would throw its own pen off the desk, it has one more go. */
  function planEasy(a, p, cfg) {
    const aim = aimAt(a, p);
    const reach = powerToReach(a, contactGap(a, p, aim), cfg.arrivalSpeed);
    const roll = () => {
      const err = U.rand(-cfg.maxAngleErrorDeg, cfg.maxAngleErrorDeg);
      return {
        angle: aim.angle + U.deg2rad(err),
        power: U.clamp(reach * U.rand(cfg.powerMin, cfg.powerMax), 0.15, 1),
        offset: U.rand(-1, 1) * cfg.grabOffsetFraction * (a.def.length / 2),
        note: `easy: ${err.toFixed(1)}° off target`,
      };
    };
    const shot = roll();
    return rehearse(a, p, shot).aiOff ? roll() : shot;
  }

  /* ---------------- MEDIUM ----------------
     A small knock-out search (centre line ± a few degrees, centre grab). If
     there's no knock-out it takes the safest-looking push, without checking
     your reply. Then its "hand" wobbles: a little angle and force error. */
  function* planMedium(a, p, cfg) {
    const s = createSearch(a, p, cfg, cfg.maxRehearsals);
    const wins = yield* knockoutSearch(s, cfg.search);
    let chosen;
    if (wins.length) chosen = bestWin(wins);
    else {
      const ranked = positionalCandidates(s.results, cfg);
      chosen = ranked.length ? ranked[0].r : { shot: { angle: aimAt(a, p).angle, power: 0.4, offset: 0 } };
    }
    const err = U.rand(-cfg.aimNoiseDeg, cfg.aimNoiseDeg);
    return {
      angle: chosen.shot.angle + U.deg2rad(err),
      power: U.clamp(chosen.shot.power * (1 + U.rand(-cfg.powerNoise, cfg.powerNoise)), 0.05, 1),
      offset: chosen.shot.offset,
      note: `${wins.length ? 'medium: knock-out attempt' : 'medium: push'}, ${err.toFixed(1)}° wobble`,
    };
  }

  /* ---------------- HARD ----------------
     1) Knock-out search: many directions around the centre line × three grab
        points (centre, and either end for spin). The real simulation is
        deterministic, so a rehearsal is a faithful preview of the real shot.
     2) No knock-out? Every rehearsed shot where nobody fell off — plus a few
        "retreat" shots toward the middle of the desk — is scored by
        positionScore, and the best few are checked by searching the PLAYER's
        straight replies. It plays the best position you can't punish. */
  function* planHard(a, p, cfg) {
    const s = createSearch(a, p, cfg, cfg.maxRehearsals);
    const wins = yield* knockoutSearch(s, cfg.search);

    let chosen;
    let replyChecks = 0;
    let safe = false;
    if (wins.length) {
      chosen = bestWin(wins);
    } else {
      // Retreats: toward the middle of the desk, straight away from the player,
      // and 45° to either side of each.
      const toCentre = Math.atan2(D.y + D.h / 2 - a.y, D.x + D.w / 2 - a.x);
      const away = aimAt(a, p).angle + Math.PI;
      const quarter = Math.PI / 4;
      const retreats = [toCentre, away, toCentre + quarter, toCentre - quarter, away + quarter, away - quarter];
      s.left += retreats.length * cfg.retreatPowers.length; // retreats always get rehearsed
      for (const angle of retreats) {
        for (const power of cfg.retreatPowers) yield* trial(s, { angle, power, offset: 0 });
      }

      const ranked = positionalCandidates(s.results, cfg);
      for (const c of ranked.slice(0, cfg.replyCandidates)) {
        replyChecks++;
        if (!(yield* playerHasReply(c.r, cfg))) {
          chosen = c.r;
          safe = true;
          break;
        }
      }
      if (!chosen && ranked.length) chosen = ranked[0].r;
      if (!chosen) {
        const all = s.results.filter((r) => !r.aiOff);
        chosen = all.length
          ? all.reduce((best, r) => (r.aiEdge > best.aiEdge ? r : best))
          : { shot: { angle: toCentre, power: 0.2, offset: 0 } };
      }
    }

    console.info('[AI hard]', {
      knockOuts: wins.length,
      chosenPower: +chosen.shot.power.toFixed(3),
      expectedWin: !!chosen.playerOff,
      rehearsals: s.results.length,
      replyChecks,
    });

    return {
      angle: chosen.shot.angle,
      power: chosen.shot.power,
      offset: chosen.shot.offset,
      note: chosen.playerOff ? 'hard: calculated knock-out' : safe ? 'hard: safe position' : 'hard: exposed position',
    };
  }

  /* ---------------- public API ---------------- */

  PG.AI = {
    createPlanner(difficulty, aiSnap, playerSnap) {
      const cfg = PG.AI_SETTINGS[difficulty];
      const gen =
        difficulty === 'hard'
          ? planHard(aiSnap, playerSnap, cfg)
          : difficulty === 'medium'
            ? planMedium(aiSnap, playerSnap, cfg)
            : (function* () {
                return planEasy(aiSnap, playerSnap, cfg);
              })();

      return PG.AI.createTask(gen);
    },

    /** Wraps a generator that yields between rehearsals in a task that main.js
        steps once per frame: task.run(budgetMs) works until the budget is spent,
        then task.done / task.result say whether it finished and what it returned. */
    createTask(gen) {
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

    /** Generator: true if the pen that shoots first could knock the other off
        straight away (main.js re-rolls such starting layouts). Use it with
        yield* inside a createTask() generator so it runs across frames. */
    hasOpeningKnockout(shooterSnap, targetSnap) {
      const fair = PG.AI_SETTINGS.FAIR_START;
      const hard = PG.AI_SETTINGS.hard;
      return hasKnockout(shooterSnap, targetSnap, hard, fair.rehearsals, fair.search || hard.search);
    },

    // Exposed for tuning / debugging from the browser console.
    _internals: { aimAt, supportExtent, rayToDeskEdge, contactGap, analyticEstimate, knockoutForce, rehearse },
  };
})((window.PenGame = window.PenGame || {}));
