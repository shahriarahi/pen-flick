/* ==========================================================================
   input.js — slingshot-style aiming with mouse, pen or touch.

   Press on your pen, drag BACKWARDS, release to flick. The launch direction is
   from the finger back toward the grab point; power grows with drag distance
   (capped at PG.INPUT.MAX_DRAG_DISTANCE). Where you grab along the pen
   matters: off-centre grabs add spin.

   Whether a press may grab at all is decided by main.js through the
   `hitTest` hook — outside the player's turn it returns null, which is how
   all input is locked while the pens are moving or the AI is playing.
   ========================================================================== */
(function (PG) {
  'use strict';

  const U = PG.util;

  PG.createInput = function createInput(canvas, hooks) {
    const cfg = PG.INPUT;
    let drag = null; // { pointerId, grab, pointer, offset }

    function computeAim() {
      const dx = drag.grab.x - drag.pointer.x;
      const dy = drag.grab.y - drag.pointer.y;
      const dist = Math.hypot(dx, dy);
      return {
        grab: drag.grab,
        pointer: drag.pointer,
        offset: drag.offset,
        angle: Math.atan2(dy, dx), // pull back → launch forward
        power: U.clamp(dist / cfg.MAX_DRAG_DISTANCE, 0, 1),
        valid: dist >= cfg.MIN_DRAG_DISTANCE,
      };
    }

    function cancel() {
      if (drag && canvas.hasPointerCapture && canvas.hasPointerCapture(drag.pointerId)) {
        canvas.releasePointerCapture(drag.pointerId);
      }
      drag = null;
      canvas.style.cursor = 'default';
    }

    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) {
        cancel(); // right/middle click cancels an aim in progress
        return;
      }
      const pt = hooks.toWorld(e.clientX, e.clientY);
      const hit = hooks.hitTest(pt, e.pointerType);
      if (!hit) return;
      drag = { pointerId: e.pointerId, grab: hit.grab, pointer: pt, offset: hit.offset };
      canvas.setPointerCapture(e.pointerId);
      canvas.style.cursor = 'grabbing';
      e.preventDefault();
    });

    canvas.addEventListener('pointermove', (e) => {
      const pt = hooks.toWorld(e.clientX, e.clientY);
      if (drag && e.pointerId === drag.pointerId) {
        drag.pointer = pt;
      } else if (!drag && e.pointerType === 'mouse') {
        canvas.style.cursor = hooks.hitTest(pt, e.pointerType) ? 'grab' : 'default';
      }
    });

    canvas.addEventListener('pointerup', (e) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      drag.pointer = hooks.toWorld(e.clientX, e.clientY);
      const aim = computeAim();
      cancel();
      if (aim.valid) hooks.onRelease(aim);
    });

    canvas.addEventListener('pointercancel', cancel);
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      cancel();
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') cancel();
    });

    return {
      /** Current aim while dragging, else null. */
      getAim: () => (drag ? computeAim() : null),
      cancel,
    };
  };
})((window.PenGame = window.PenGame || {}));
