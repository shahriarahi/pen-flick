/* ==========================================================================
   physics.js — Matter.js world setup, pen bodies, flick impulses, the
   "has it tipped off the desk?" test and "have the pens stopped?" detection.

   PG.createPhysics() builds a completely self-contained world. The game uses
   one for the real match, and the Hard AI spins up throw-away copies to
   rehearse candidate shots (see ai.js).
   ========================================================================== */
(function (PG) {
  'use strict';

  const { Engine, Bodies, Body, Composite, Events } = Matter;
  const P = PG.PHYSICS;
  const D = PG.DESK;

  // Matter.js 0.19 reports velocities "per 16.67 ms" via Body.getVelocity,
  // independent of the sub-step size. Fall back to the raw property on older builds.
  function velocityOf(body) {
    return Body.getVelocity ? Body.getVelocity(body) : { x: body.velocity.x, y: body.velocity.y };
  }
  function angularVelocityOf(body) {
    return Body.getAngularVelocity ? Body.getAngularVelocity(body) : body.angularVelocity;
  }

  PG.createPhysics = function createPhysics() {
    const engine = Engine.create({
      enableSleeping: false, // we do our own, stricter "settled" check
      positionIterations: P.POSITION_ITERATIONS,
      velocityIterations: P.VELOCITY_ITERATIONS,
    });

    // TOP-DOWN VIEW: there is no gravity. Pens slow down purely through each
    // body's `frictionAir` (our stand-in for desk friction).
    engine.gravity.x = 0;
    engine.gravity.y = 0;
    engine.gravity.scale = 0;

    // ---- Pen-on-pen impact notifications (used for visual effects) -------
    const collisionListeners = [];
    Events.on(engine, 'collisionStart', (event) => {
      if (!collisionListeners.length) return;
      for (const pair of event.pairs) {
        const a = pair.bodyA;
        const b = pair.bodyB;
        if (a.label !== 'pen' || b.label !== 'pen') continue;
        const sup = pair.collision && pair.collision.supports;
        const pt =
          sup && sup[0] && typeof sup[0].x === 'number'
            ? { x: sup[0].x, y: sup[0].y }
            : { x: (a.position.x + b.position.x) / 2, y: (a.position.y + b.position.y) / 2 };
        const va = velocityOf(a);
        const vb = velocityOf(b);
        const speed = Math.hypot(va.x - vb.x, va.y - vb.y);
        collisionListeners.forEach((cb) => cb({ x: pt.x, y: pt.y, speed }));
      }
    });

    /** Creates a Matter.js body for a pen definition from config.js. */
    function addPen(def, x, y, angle, owner) {
      const body = Bodies.rectangle(x, y, def.length, def.width, {
        label: 'pen',
        // Rounded ends so pens glance off each other instead of snagging on corners.
        chamfer: { radius: def.width * 0.45 },

        // ===== PHYSICS TUNING (values come from PG.PENS in config.js) =====
        frictionAir: def.frictionAir, // desk drag: how fast it slows down
        friction: def.friction, // pen-on-pen rubbing
        frictionStatic: def.frictionStatic, // pen-on-pen stickiness at rest
        restitution: def.restitution, // pen-on-pen bounciness
      });

      // Mass must be set AFTER creation; Body.setMass also rescales the
      // moment of inertia proportionally, so heavier pens resist spinning too.
      Body.setMass(body, def.mass);
      Body.setInertia(body, body.inertia * P.INERTIA_MULTIPLIER);
      Body.setAngle(body, angle);

      body.plugin.pen = { def, owner };
      Composite.add(engine.world, body);
      return body;
    }

    function removePen(body) {
      Composite.remove(engine.world, body);
    }

    /** Advances the world by exactly one fixed tick (several Matter sub-steps). */
    function step() {
      const dt = P.TICK_MS / P.SUBSTEPS;
      for (let i = 0; i < P.SUBSTEPS; i++) Engine.update(engine, dt);
    }

    /**
     * Converts a flick (direction, power 0..1, grab offset along the pen's axis)
     * into the resulting linear and angular velocity — impulse physics:
     *    Δv = J / m          Δω = (r × J) / I
     * Grabbing the pen off-centre gives a lever arm r, so the flick also spins it.
     */
    function computeFlick(body, angle, power, axisOffset) {
      const def = body.plugin.pen.def;
      const J = PG.util.clamp(power, 0, 1) * P.MAX_FLICK_IMPULSE * def.powerScale;
      const jx = Math.cos(angle) * J;
      const jy = Math.sin(angle) * J;
      const rx = Math.cos(body.angle) * axisOffset;
      const ry = Math.sin(body.angle) * axisOffset;
      const torque = rx * jy - ry * jx; // 2D cross product r × J
      return {
        vx: jx / body.mass,
        vy: jy / body.mass,
        omega: (torque / body.inertia) * P.SPIN_FACTOR,
      };
    }

    function flick(body, angle, power, axisOffset) {
      const f = computeFlick(body, angle, power, axisOffset);
      Body.setVelocity(body, { x: f.vx, y: f.vy });
      Body.setAngularVelocity(body, f.omega);
      return f;
    }

    /** Hard-zeroes a body's motion once it has (nearly) stopped. */
    function stop(body) {
      Body.setVelocity(body, { x: 0, y: 0 });
      Body.setAngularVelocity(body, 0);
    }

    /**
     * True while the pen's centre of mass is still over the desk. A pen is a
     * uniform rod, so it tips over the edge the moment its centre crosses it —
     * i.e. as soon as more than half of its body hangs off. The edges carry no
     * collision body, so pens slide freely across them.
     */
    function isOnDesk(body) {
      const { x, y } = body.position;
      return x >= D.x && x <= D.x + D.w && y >= D.y && y <= D.y + D.h;
    }

    /** True when every body's linear AND angular speed is below the tiny thresholds. */
    function isSettled(bodies) {
      return bodies.every((b) => {
        const v = velocityOf(b);
        return (
          Math.hypot(v.x, v.y) < P.SETTLE_SPEED &&
          Math.abs(angularVelocityOf(b)) < P.SETTLE_ANGULAR_SPEED
        );
      });
    }

    /** Distance from the pen's bounding box to the nearest desk edge (negative = hanging over). */
    function edgeClearance(body) {
      const b = body.bounds;
      return Math.min(b.min.x - D.x, D.x + D.w - b.max.x, b.min.y - D.y, D.y + D.h - b.max.y);
    }

    /**
     * Did a press at (x, y) grab this pen? Returns the grab offset along the
     * pen's long axis (used for spin) and the grab point on that axis, or null.
     */
    function hitTestPen(body, x, y, tolerance) {
      const def = body.plugin.pen.def;
      const ax = Math.cos(body.angle);
      const ay = Math.sin(body.angle);
      const dx = x - body.position.x;
      const dy = y - body.position.y;
      const along = dx * ax + dy * ay;
      const across = -dx * ay + dy * ax;
      const hl = def.length / 2;
      const beyondEnd = Math.max(0, Math.abs(along) - hl);
      if (Math.abs(across) > def.width / 2 + tolerance || beyondEnd > tolerance) return null;
      const offset = PG.util.clamp(along, -hl * 0.92, hl * 0.92);
      return {
        offset,
        grab: { x: body.position.x + ax * offset, y: body.position.y + ay * offset },
      };
    }

    return {
      engine,
      addPen,
      removePen,
      step,
      computeFlick,
      flick,
      stop,
      isOnDesk,
      isSettled,
      edgeClearance,
      hitTestPen,
      velocityOf,
      angularVelocityOf,
      onPenCollision: (cb) => collisionListeners.push(cb),
    };
  };

  /* ------------------------------------------------------------------------
     Closed-form motion model (used by the AI and handy for tuning).

     Each sub-step Matter multiplies velocity by (1 - frictionAir / SUBSTEPS),
     which makes speed fall LINEARLY with distance travelled:
         v(s) = v0 - κ·s,   κ = frictionAir / (1 - frictionAir / SUBSTEPS)
     So a pen launched at v0 slides  v0 / κ  units before stopping.
     ------------------------------------------------------------------------ */
  PG.PhysicsModel = {
    maxLaunchSpeed: (def) => (P.MAX_FLICK_IMPULSE * def.powerScale) / def.mass,
    decelPerUnit: (def) => def.frictionAir / (1 - def.frictionAir / P.SUBSTEPS),
    slideDistance: (def, v0) => v0 / PG.PhysicsModel.decelPerUnit(def),
    speedForDistance: (def, d) => d * PG.PhysicsModel.decelPerUnit(def),

    /** Point where a ray from the pen's centre along (ux, uy) exits its rectangle. */
    frontPoint(body, def, ux, uy) {
      const ax = Math.cos(body.angle);
      const ay = Math.sin(body.angle);
      const lx = Math.abs(ux * ax + uy * ay);
      const ly = Math.abs(-ux * ay + uy * ax);
      const t = Math.min(
        lx > 1e-6 ? def.length / 2 / lx : Infinity,
        ly > 1e-6 ? def.width / 2 / ly : Infinity
      );
      return { x: body.position.x + ux * t, y: body.position.y + uy * t };
    },
  };
})((window.PenGame = window.PenGame || {}));
