/* ==========================================================================
   renderer.js — everything drawn on the canvas.

   • Responsive scaling: the logical world (PG.VIEW) is scaled to fit the
     window and rendered at device-pixel resolution for crisp output.
   • Procedural wooden desk, cached in an off-screen canvas.
   • Realistic top-down pens built from linear gradients (cylindrical shading
     that follows a fixed top-left light as the pen rotates), metallic chrome /
     gold gradients, and soft drop shadows.
   • Aiming UI: slingshot band, curved trajectory arrow, green→red power meter.
   ========================================================================== */
(function (PG) {
  'use strict';

  const U = PG.util;
  const VIEW = PG.VIEW;
  const D = PG.DESK;

  // Direction TOWARD the light source in world space (top-left of the desk).
  const LIGHT_DIR = { x: -0.55, y: -0.835 };
  // Per-pen lighting state, recomputed for each pen's rotation (see setLight).
  const light = { ly: -1, h: 0.25 };
  // Used by the "shadow-only" drawing trick (see castShadow).
  const FAR = 10000;

  const METALS = {
    chrome: ['#3b3f44', '#cfd4da', '#ffffff', '#8f959c', '#e6e9ec', '#4f5359'],
    gold: ['#55380a', '#d4a23a', '#fff1c2', '#ad7f27', '#efcc70', '#664609'],
    graphite: ['#151618', '#4a4c50', '#b4b7bd', '#3a3c40', '#6c6f74', '#111214'],
  };

  // How far back from the tip each pen's outline starts to taper (for its shadow).
  const TAPER = { fountain: 50, pencil: 26, gel: 26, tactical: 26 };

  /* ------------------------------------------------------------------------
     Lighting helpers
     ------------------------------------------------------------------------ */

  /** Where (across the pen's width) the specular highlight sits for this rotation. */
  function setLight(angle) {
    // Light direction expressed in the pen's local frame (y = across the pen).
    light.ly = -Math.sin(angle) * LIGHT_DIR.x + Math.cos(angle) * LIGHT_DIR.y;
    light.h = 0.5 + 0.32 * light.ly; // 0 = top edge of the pen, 1 = bottom edge
  }

  /** Linear gradient across the pen's width that fakes a shiny cylinder. */
  function cylGradient(ctx, hw, color, gloss) {
    const g = ctx.createLinearGradient(0, -hw, 0, hw);
    const h = light.h;
    g.addColorStop(0, U.shade(color, -0.6));
    g.addColorStop(Math.max(0.01, h - 0.2), U.shade(color, -0.05));
    g.addColorStop(h, U.shade(color, gloss == null ? 0.5 : gloss));
    g.addColorStop(Math.min(0.95, h + 0.1), U.shade(color, 0.1));
    g.addColorStop(Math.min(0.97, h + 0.42), U.shade(color, -0.25));
    g.addColorStop(1, U.shade(color, -0.65));
    return g;
  }

  /** Banded high-contrast gradient that reads as polished metal. */
  function metalGradient(ctx, hw, kind) {
    const m = METALS[kind];
    const h = light.h;
    const g = ctx.createLinearGradient(0, -hw, 0, hw);
    g.addColorStop(0, m[0]);
    g.addColorStop(Math.max(0.01, h - 0.18), m[1]);
    g.addColorStop(h, m[2]);
    g.addColorStop(Math.min(0.95, h + 0.14), m[3]);
    g.addColorStop(Math.min(0.97, h + 0.36), m[4]);
    g.addColorStop(1, m[5]);
    return g;
  }

  /** Thin bright streak along the barrel on the lit side. */
  function specular(ctx, x0, x1, hw, alpha) {
    const y = light.ly * hw * 0.5;
    ctx.fillStyle = `rgba(255,255,255,${alpha == null ? 0.35 : alpha})`;
    rr(ctx, x0, y - hw * 0.09, x1 - x0, hw * 0.18, hw * 0.09);
    ctx.fill();
  }

  /** Rounded-rectangle path (begins a new path). */
  function rr(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function line(ctx, x0, y0, x1, y1) {
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }

  /** Approximate outline of each pen, used only to cast its shadow / glow. */
  function outlinePath(ctx, def) {
    const hl = def.length / 2;
    const hw = def.width / 2;
    if (def.style === 'marker') {
      rr(ctx, -hl, -hw, def.length, def.width, hw * 0.7);
      return;
    }
    const taper = TAPER[def.style] || 30;
    const r = hw * 0.6;
    ctx.beginPath();
    ctx.moveTo(hl - taper, -hw);
    ctx.lineTo(-hl + r, -hw);
    ctx.quadraticCurveTo(-hl, -hw, -hl, -hw + r);
    ctx.lineTo(-hl, hw - r);
    ctx.quadraticCurveTo(-hl, hw, -hl + r, hw);
    ctx.lineTo(hl - taper, hw);
    ctx.lineTo(hl, 1.3);
    ctx.lineTo(hl, -1.3);
    ctx.closePath();
  }

  /**
   * Draws ONLY the shadow of the pen outline. The shape itself is painted far
   * off-screen and the shadow offset brings it back into place, so the
   * silhouette never shows through gaps in the pen artwork. (Shadow offsets are
   * in device pixels and ignore rotation, so the shadow always falls
   * bottom-right no matter how the pen is turned.)
   */
  function castShadow(ctx, def, color, blur, ox, oy) {
    const m = ctx.getTransform();
    ctx.save();
    ctx.setTransform(m.a, m.b, m.c, m.d, m.e - FAR, m.f);
    ctx.shadowColor = color;
    ctx.shadowBlur = blur;
    ctx.shadowOffsetX = ox + FAR;
    ctx.shadowOffsetY = oy;
    ctx.fillStyle = '#000';
    outlinePath(ctx, def);
    ctx.fill();
    ctx.restore();
  }

  /** Small contact shadow under raised parts (clips). */
  function withSmallShadow(ctx, ps, fn) {
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 2.5 * ps;
    ctx.shadowOffsetX = 1.3 * ps;
    ctx.shadowOffsetY = 1.8 * ps;
    fn();
    ctx.restore();
  }

  /* ------------------------------------------------------------------------
     The three pen designs. Local coordinates: the pen lies along the x-axis,
     centred on (0, 0), writing tip at +x. `cw` is the colourway, `ps` is the
     number of device pixels per local unit (to scale small shadows).
     ------------------------------------------------------------------------ */

  function drawBallpoint(ctx, def, cw, ps) {
    const hl = def.length / 2;
    const hw = def.width / 2;
    const plugEnd = -hl + 13;
    const gripStart = hl - 64;
    const gripEnd = hl - 30;
    const metalStart = hl - 13;

    // Barrel (translucent coloured plastic)
    ctx.fillStyle = cylGradient(ctx, hw, cw.primary, 0.55);
    rr(ctx, plugEnd - 3, -hw, gripStart - plugEnd + 6, hw * 2, 2.5);
    ctx.fill();

    // Ink refill visible through the barrel
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    ctx.fillRect(plugEnd + 2, -hw * 0.3, gripStart - plugEnd - 2, hw * 0.6);
    ctx.fillStyle = U.rgba(cw.ink, 0.65);
    ctx.fillRect(plugEnd + 6, -hw * 0.14, gripStart - plugEnd - 10, hw * 0.28);

    // Hexagonal facet edges
    ctx.strokeStyle = 'rgba(255,255,255,0.13)';
    ctx.lineWidth = 0.6;
    line(ctx, plugEnd, -hw * 0.5, gripStart, -hw * 0.5);
    line(ctx, plugEnd, hw * 0.5, gripStart, hw * 0.5);

    // Rear plug
    ctx.fillStyle = cylGradient(ctx, hw * 0.86, U.shade(cw.primary, -0.35), 0.4);
    rr(ctx, -hl, -hw * 0.86, 16, hw * 1.72, hw * 0.7);
    ctx.fill();

    // Rubber grip with ridges
    ctx.fillStyle = cylGradient(ctx, hw * 1.05, '#2a2c30', 0.3);
    rr(ctx, gripStart, -hw * 1.05, gripEnd - gripStart, hw * 2.1, 3);
    ctx.fill();
    ctx.lineWidth = 0.9;
    for (let x = gripStart + 3; x < gripEnd - 1; x += 3.2) {
      ctx.strokeStyle = 'rgba(0,0,0,0.45)';
      line(ctx, x, -hw * 0.98, x, hw * 0.98);
      ctx.strokeStyle = 'rgba(255,255,255,0.10)';
      line(ctx, x + 1, -hw * 0.98, x + 1, hw * 0.98);
    }

    // Front cone (barrel plastic)
    ctx.fillStyle = cylGradient(ctx, hw * 0.95, cw.primary, 0.55);
    ctx.beginPath();
    ctx.moveTo(gripEnd - 1, -hw * 0.95);
    ctx.lineTo(metalStart, -hw * 0.5);
    ctx.lineTo(metalStart, hw * 0.5);
    ctx.lineTo(gripEnd - 1, hw * 0.95);
    ctx.closePath();
    ctx.fill();

    // Chrome writing tip + ball
    ctx.fillStyle = metalGradient(ctx, hw * 0.5, 'chrome');
    ctx.beginPath();
    ctx.moveTo(metalStart, -hw * 0.5);
    ctx.lineTo(hl - 1.6, -1.3);
    ctx.lineTo(hl - 1.6, 1.3);
    ctx.lineTo(metalStart, hw * 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#1d1f22';
    ctx.beginPath();
    ctx.arc(hl - 1.4, 0, 1.5, 0, Math.PI * 2);
    ctx.fill();

    specular(ctx, plugEnd + 68, gripStart - 4, hw, 0.38);

    // Chrome pocket clip (raised, casts its own little shadow)
    withSmallShadow(ctx, ps, () => {
      ctx.fillStyle = metalGradient(ctx, 2.6, 'chrome');
      rr(ctx, -hl + 2, -2.6, 64, 5.2, 2.6);
      ctx.fill();
    });
  }

  function drawFountain(ctx, def, cw, ps) {
    const hl = def.length / 2;
    const hw = def.width / 2;
    const bw = hw * 0.86; // barrel is slightly slimmer than the posted cap
    const capEnd = -hl + 50;
    const ringX = hl - 56;
    const nibStart = hl - 30;

    // Lacquered barrel
    ctx.fillStyle = cylGradient(ctx, bw, cw.lacquer, 0.7);
    rr(ctx, capEnd - 6, -bw, ringX - capEnd + 8, bw * 2, 3);
    ctx.fill();

    // Black resin grip section (tapered)
    ctx.fillStyle = cylGradient(ctx, bw * 0.8, '#141518', 0.45);
    ctx.beginPath();
    ctx.moveTo(ringX + 3, -bw * 0.8);
    ctx.lineTo(nibStart + 2, -bw * 0.62);
    ctx.lineTo(nibStart + 2, bw * 0.62);
    ctx.lineTo(ringX + 3, bw * 0.8);
    ctx.closePath();
    ctx.fill();

    // Gold trim ring
    ctx.fillStyle = metalGradient(ctx, bw * 0.92, 'gold');
    rr(ctx, ringX, -bw * 0.92, 5, bw * 1.84, 1.2);
    ctx.fill();

    // Gold nib
    ctx.fillStyle = metalGradient(ctx, bw * 0.58, 'gold');
    ctx.beginPath();
    ctx.moveTo(nibStart, -bw * 0.58);
    ctx.quadraticCurveTo(hl - 10, -bw * 0.5, hl, 0);
    ctx.quadraticCurveTo(hl - 10, bw * 0.5, nibStart, bw * 0.58);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(80,52,8,0.65)';
    ctx.lineWidth = 0.7;
    ctx.stroke();
    // Breather hole, slit and scroll engraving
    ctx.fillStyle = '#3a2706';
    ctx.beginPath();
    ctx.arc(nibStart + 10, 0, 1.7, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#3a2706';
    ctx.lineWidth = 0.8;
    line(ctx, nibStart + 11.5, 0, hl - 0.8, 0);
    ctx.strokeStyle = 'rgba(110,75,15,0.55)';
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.arc(nibStart + 10, 0, 4.5, -1.2, 1.2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(nibStart + 5, 0, 5.5, -1, 1);
    ctx.stroke();

    // Posted cap over the rear of the barrel
    ctx.fillStyle = cylGradient(ctx, hw, cw.lacquer, 0.7);
    rr(ctx, -hl + 5, -hw, capEnd + hl - 5, hw * 2, 4);
    ctx.fill();

    // Gold cap band with an engraved line
    ctx.fillStyle = metalGradient(ctx, hw * 1.02, 'gold');
    rr(ctx, capEnd - 9, -hw * 1.02, 7, hw * 2.04, 1.5);
    ctx.fill();
    ctx.strokeStyle = 'rgba(90,60,10,0.5)';
    ctx.lineWidth = 0.6;
    line(ctx, capEnd - 5.5, -hw, capEnd - 5.5, hw);

    // Gold finial on the end of the cap
    ctx.fillStyle = metalGradient(ctx, hw * 0.72, 'gold');
    rr(ctx, -hl, -hw * 0.72, 9, hw * 1.44, hw * 0.55);
    ctx.fill();

    // Deep lacquer gloss
    specular(ctx, capEnd + 2, ringX - 4, bw, 0.45);
    specular(ctx, -hl + 12, capEnd - 12, hw, 0.4);

    // Gold clip with a ball end
    withSmallShadow(ctx, ps, () => {
      ctx.fillStyle = metalGradient(ctx, 2.9, 'gold');
      rr(ctx, -hl + 6, -2.9, 60, 5.8, 2.2);
      ctx.fill();
      const bx = -hl + 64;
      const ball = ctx.createRadialGradient(bx - 1, light.ly * 1.5, 0.4, bx, 0, 3.9);
      ball.addColorStop(0, '#fff6d0');
      ball.addColorStop(0.45, '#d4a23a');
      ball.addColorStop(1, '#5a3c0b');
      ctx.fillStyle = ball;
      ctx.beginPath();
      ctx.arc(bx, 0, 3.9, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  function drawMarker(ctx, def, cw, ps) {
    const hl = def.length / 2;
    const hw = def.width / 2;
    const capStart = hl - 58;

    // White plastic body
    ctx.fillStyle = cylGradient(ctx, hw * 0.94, '#e7eaee', 0.6);
    rr(ctx, -hl + 8, -hw * 0.94, capStart + hl - 4, hw * 1.88, 4);
    ctx.fill();

    // Coloured rear plug
    ctx.fillStyle = cylGradient(ctx, hw * 0.8, U.shade(cw.primary, -0.15), 0.4);
    rr(ctx, -hl, -hw * 0.8, 13, hw * 1.6, hw * 0.6);
    ctx.fill();

    // Colour band + printed label
    ctx.fillStyle = cylGradient(ctx, hw * 0.94, cw.primary, 0.45);
    ctx.fillRect(-hl + 24, -hw * 0.94, 14, hw * 1.88);
    ctx.save();
    ctx.fillStyle = U.shade(cw.primary, -0.25);
    ctx.font = `700 ${Math.round(hw * 0.62)}px "Segoe UI", Arial, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText('MARKER', -hl + 44, 0.5);
    ctx.restore();

    // Metal ring between body and cap
    ctx.fillStyle = cylGradient(ctx, hw * 0.97, '#7d848c', 0.5);
    ctx.fillRect(capStart - 3, -hw * 0.97, 4, hw * 1.94);

    // Big coloured cap with a rounded end
    ctx.fillStyle = cylGradient(ctx, hw, cw.primary, 0.55);
    rr(ctx, capStart, -hw, hl - capStart, hw * 2, hw * 0.75);
    ctx.fill();

    // Cap grip ridges
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    for (let i = 0; i < 5; i++) {
      const x = capStart + 4 + i * 2.6;
      line(ctx, x, -hw * 0.95, x, hw * 0.95);
    }

    specular(ctx, -hl + 14, capStart - 6, hw * 0.94, 0.45);
    specular(ctx, capStart + 18, hl - 10, hw, 0.3);

    // Moulded cap clip
    withSmallShadow(ctx, ps, () => {
      ctx.fillStyle = cylGradient(ctx, 3.6, U.shade(cw.primary, 0.12), 0.6);
      rr(ctx, capStart + 12, -3.6, 34, 7.2, 3.6);
      ctx.fill();
    });
  }

  function drawGel(ctx, def, cw, ps) {
    const hl = def.length / 2;
    const hw = def.width / 2;
    const plungerEnd = -hl + 12;
    const gripStart = hl - 60;
    const gripEnd = hl - 24;
    const tipStart = hl - 7;
    const plastic = U.mix(cw.primary, '#ffffff', 0.15);

    // Chrome click plunger
    ctx.fillStyle = metalGradient(ctx, hw * 0.55, 'chrome');
    rr(ctx, -hl, -hw * 0.55, 16, hw * 1.1, hw * 0.4);
    ctx.fill();

    // Translucent barrel
    ctx.fillStyle = cylGradient(ctx, hw, plastic, 0.6);
    rr(ctx, plungerEnd, -hw, gripStart - plungerEnd + 4, hw * 2, hw * 0.5);
    ctx.fill();

    // Fat gel refill and the retraction spring, seen through the barrel
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.fillRect(plungerEnd + 4, -hw * 0.34, gripStart - plungerEnd - 4, hw * 0.68);
    ctx.fillStyle = U.rgba(cw.ink, 0.8);
    ctx.fillRect(plungerEnd + 8, -hw * 0.2, gripStart - plungerEnd - 30, hw * 0.4);
    ctx.strokeStyle = 'rgba(225,230,235,0.75)';
    ctx.lineWidth = 0.8;
    for (let x = gripStart - 20; x < gripStart; x += 2.5) line(ctx, x, -hw * 0.3, x + 1.2, hw * 0.3);

    // Dimpled rubber grip
    ctx.fillStyle = cylGradient(ctx, hw * 1.06, '#3a3d44', 0.25);
    rr(ctx, gripStart, -hw * 1.06, gripEnd - gripStart, hw * 2.12, 4);
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.38)';
    for (let x = gripStart + 4; x < gripEnd - 3; x += 4.5) {
      for (const y of [-hw * 0.52, 0, hw * 0.52]) {
        ctx.beginPath();
        ctx.arc(x + (y === 0 ? 2.2 : 0), y, 1.1, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Front cone + needle tip
    ctx.fillStyle = cylGradient(ctx, hw * 0.95, plastic, 0.6);
    ctx.beginPath();
    ctx.moveTo(gripEnd - 1, -hw * 0.95);
    ctx.lineTo(tipStart, -hw * 0.38);
    ctx.lineTo(tipStart, hw * 0.38);
    ctx.lineTo(gripEnd - 1, hw * 0.95);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = metalGradient(ctx, hw * 0.38, 'chrome');
    ctx.beginPath();
    ctx.moveTo(tipStart, -hw * 0.38);
    ctx.lineTo(hl - 1.2, -1);
    ctx.lineTo(hl - 1.2, 1);
    ctx.lineTo(tipStart, hw * 0.38);
    ctx.closePath();
    ctx.fill();

    specular(ctx, plungerEnd + 6, gripStart - 4, hw, 0.4);

    // Big moulded clip
    withSmallShadow(ctx, ps, () => {
      ctx.fillStyle = cylGradient(ctx, 3.4, U.shade(cw.primary, -0.1), 0.55);
      rr(ctx, -hl + 8, -3.4, 62, 6.8, 3.4);
      ctx.fill();
    });
  }

  function drawPencil(ctx, def, cw, ps) {
    const hl = def.length / 2;
    const hw = def.width / 2;
    const eraserEnd = -hl + 12;
    const ferruleEnd = -hl + 27;
    const woodStart = hl - 28;
    const leadStart = hl - 9;

    // Eraser
    ctx.fillStyle = cylGradient(ctx, hw * 0.92, '#e8909c', 0.3);
    rr(ctx, -hl, -hw * 0.92, 15, hw * 1.84, hw * 0.55);
    ctx.fill();

    // Painted hexagonal body (three flat facets visible from above)
    const paint = cylGradient(ctx, hw, cw.primary, 0.45);
    ctx.fillStyle = paint;
    ctx.fillRect(ferruleEnd - 2, -hw, woodStart - ferruleEnd + 3, hw * 2);
    ctx.lineWidth = 0.7;
    for (const y of [-hw * 0.5, hw * 0.5]) {
      ctx.strokeStyle = 'rgba(0,0,0,0.28)';
      line(ctx, ferruleEnd, y, woodStart, y);
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      line(ctx, ferruleEnd, y + 0.7, woodStart, y + 0.7);
    }

    // Gold-foil stamp
    ctx.save();
    ctx.fillStyle = 'rgba(255,225,140,0.9)';
    ctx.font = `700 ${(hw * 0.85).toFixed(1)}px Georgia, serif`;
    ctx.textBaseline = 'middle';
    ctx.fillText('HB  No.2', ferruleEnd + 10, 0.4);
    ctx.restore();

    // Sharpened wood cone, with the paint's scalloped edge
    ctx.fillStyle = cylGradient(ctx, hw, '#e6c49a', 0.35);
    ctx.beginPath();
    ctx.moveTo(woodStart - 2, -hw);
    ctx.lineTo(leadStart, -hw * 0.34);
    ctx.lineTo(leadStart, hw * 0.34);
    ctx.lineTo(woodStart - 2, hw);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = paint;
    for (const [y0, y1] of [[-hw, -hw * 0.5], [-hw * 0.5, hw * 0.5], [hw * 0.5, hw]]) {
      ctx.beginPath();
      ctx.moveTo(woodStart - 2, y0);
      ctx.quadraticCurveTo(woodStart + (y0 === -hw * 0.5 ? 9 : 6), (y0 + y1) / 2, woodStart - 2, y1);
      ctx.closePath();
      ctx.fill();
    }
    ctx.strokeStyle = 'rgba(150,100,50,0.35)';
    ctx.lineWidth = 0.6;
    line(ctx, woodStart + 6, -hw * 0.45, leadStart, -hw * 0.18);
    line(ctx, woodStart + 6, hw * 0.45, leadStart, hw * 0.18);

    // Graphite lead
    ctx.fillStyle = metalGradient(ctx, hw * 0.34, 'graphite');
    ctx.beginPath();
    ctx.moveTo(leadStart, -hw * 0.34);
    ctx.lineTo(hl, -0.6);
    ctx.lineTo(hl, 0.6);
    ctx.lineTo(leadStart, hw * 0.34);
    ctx.closePath();
    ctx.fill();

    specular(ctx, ferruleEnd + 2, woodStart - 3, hw, 0.3);

    // Crimped brass ferrule with a team-coloured band (slightly raised)
    withSmallShadow(ctx, ps * 0.6, () => {
      ctx.fillStyle = metalGradient(ctx, hw * 1.04, 'gold');
      rr(ctx, eraserEnd, -hw * 1.04, ferruleEnd - eraserEnd, hw * 2.08, 1.5);
      ctx.fill();
    });
    ctx.fillStyle = U.rgba(cw.primary, 0.55);
    ctx.fillRect(eraserEnd + 6, -hw * 1.04, 3.5, hw * 2.08);
    ctx.strokeStyle = 'rgba(70,45,5,0.55)';
    ctx.lineWidth = 0.8;
    for (const x of [eraserEnd + 2.5, eraserEnd + 4.5, ferruleEnd - 4.5, ferruleEnd - 2.5]) {
      line(ctx, x, -hw, x, hw);
    }
  }

  function drawTactical(ctx, def, cw, ps) {
    const hl = def.length / 2;
    const hw = def.width / 2;
    const breakerEnd = -hl + 12;
    const knurlStart = hl - 64;
    const knurlEnd = hl - 30;
    const coneEnd = hl - 6;
    const anodised = U.shade(cw.primary, -0.38);

    // Tungsten glass-breaker tail
    ctx.fillStyle = metalGradient(ctx, hw * 0.8, 'chrome');
    ctx.beginPath();
    ctx.moveTo(breakerEnd + 2, -hw * 0.8);
    ctx.lineTo(-hl + 3, -hw * 0.3);
    ctx.quadraticCurveTo(-hl - 1, 0, -hl + 3, hw * 0.3);
    ctx.lineTo(breakerEnd + 2, hw * 0.8);
    ctx.closePath();
    ctx.fill();

    // Satin anodised body (low gloss)
    ctx.fillStyle = cylGradient(ctx, hw, anodised, 0.35);
    rr(ctx, breakerEnd, -hw, knurlStart - breakerEnd + 2, hw * 2, 2);
    ctx.fill();

    // Machined grooves
    for (const x of [breakerEnd + 6, breakerEnd + 9, knurlStart - 8]) {
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = 1.2;
      line(ctx, x, -hw, x, hw);
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.lineWidth = 0.6;
      line(ctx, x + 1.2, -hw, x + 1.2, hw);
    }

    // Knurled steel grip: diamond cross-hatch
    const kTop = -hw * 0.96;
    const kH = hw * 1.92;
    ctx.fillStyle = metalGradient(ctx, hw * 0.96, 'chrome');
    ctx.fillRect(knurlStart, kTop, knurlEnd - knurlStart, kH);
    ctx.save();
    ctx.beginPath();
    ctx.rect(knurlStart, kTop, knurlEnd - knurlStart, kH);
    ctx.clip();
    ctx.strokeStyle = 'rgba(30,32,36,0.45)';
    ctx.lineWidth = 0.7;
    for (let x = knurlStart - hw * 2; x < knurlEnd + hw * 2; x += 3) {
      line(ctx, x, -hw, x + hw * 2, hw);
      line(ctx, x, hw, x + hw * 2, -hw);
    }
    ctx.restore();

    // Front cone and refill tip
    ctx.fillStyle = cylGradient(ctx, hw, anodised, 0.35);
    ctx.beginPath();
    ctx.moveTo(knurlEnd, -hw * 0.96);
    ctx.lineTo(coneEnd, -hw * 0.3);
    ctx.lineTo(coneEnd, hw * 0.3);
    ctx.lineTo(knurlEnd, hw * 0.96);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = metalGradient(ctx, hw * 0.3, 'chrome');
    ctx.beginPath();
    ctx.moveTo(coneEnd, -hw * 0.3);
    ctx.lineTo(hl - 1, -1);
    ctx.lineTo(hl - 1, 1);
    ctx.lineTo(coneEnd, hw * 0.3);
    ctx.closePath();
    ctx.fill();

    specular(ctx, breakerEnd + 12, knurlStart - 12, hw, 0.22);

    // Heavy steel clip with two screws
    withSmallShadow(ctx, ps, () => {
      ctx.fillStyle = metalGradient(ctx, 3.6, 'chrome');
      rr(ctx, -hl + 14, -3.6, 58, 7.2, 2);
      ctx.fill();
    });
    ctx.fillStyle = '#2a2c30';
    for (const x of [-hl + 19, -hl + 25]) {
      ctx.beginPath();
      ctx.arc(x, 0, 1.3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const DRAWERS = {
    ballpoint: drawBallpoint,
    fountain: drawFountain,
    marker: drawMarker,
    gel: drawGel,
    pencil: drawPencil,
    tactical: drawTactical,
  };

  /* ------------------------------------------------------------------------
     Renderer factory
     ------------------------------------------------------------------------ */
  PG.createRenderer = function createRenderer(canvas, stage) {
    const ctx = canvas.getContext('2d');
    let px = 1; // device pixels per world unit
    let background = null;

    /** Draws one pen at a world position/rotation. */
    function drawPenAt(c, def, cw, x, y, angle, opts) {
      opts = opts || {};
      const ps = (opts.pxScale || px) * (opts.scale || 1);
      const lift = opts.lift || 1;
      c.save();
      c.translate(x, y);
      c.rotate(angle);
      if (opts.scale && opts.scale !== 1) c.scale(opts.scale, opts.scale);
      c.globalAlpha = opts.alpha == null ? 1 : opts.alpha;
      setLight(angle);

      castShadow(c, def, 'rgba(0,0,0,0.55)', 8 * ps * lift, 5 * ps * lift, 7 * ps * lift);
      if (opts.glow) {
        castShadow(c, def, cw.glow, 22 * ps * opts.glow, 0, 0);
        castShadow(c, def, cw.glow, 8 * ps * opts.glow, 0, 0);
      }
      DRAWERS[def.style](c, def, cw, ps);
      c.restore();
    }

    /* ---------------- background (floor + desk), cached ---------------- */

    function paintFloor(g) {
      const grd = g.createRadialGradient(
        VIEW.width / 2, VIEW.height / 2, 100,
        VIEW.width / 2, VIEW.height / 2, VIEW.width * 0.75
      );
      grd.addColorStop(0, '#36312c');
      grd.addColorStop(1, '#131110');
      g.fillStyle = grd;
      g.fillRect(0, 0, VIEW.width, VIEW.height);
      // Floor tiles
      g.lineWidth = 2;
      g.strokeStyle = 'rgba(0,0,0,0.35)';
      for (let x = 0; x <= VIEW.width; x += 80) line(g, x, 0, x, VIEW.height);
      for (let y = 0; y <= VIEW.height; y += 80) line(g, 0, y, VIEW.width, y);
      g.lineWidth = 1;
      g.strokeStyle = 'rgba(255,255,255,0.035)';
      for (let x = 2; x <= VIEW.width; x += 80) line(g, x, 0, x, VIEW.height);
      for (let y = 2; y <= VIEW.height; y += 80) line(g, 0, y, VIEW.width, y);
    }

    function paintDesk(g) {
      const rnd = U.mulberry32(20240611);
      const cx = D.x + D.w / 2;
      const cy = D.y + D.h / 2;

      // Desk casts a soft shadow onto the floor
      g.save();
      g.shadowColor = 'rgba(0,0,0,0.75)';
      g.shadowBlur = 28 * px;
      g.shadowOffsetX = 6 * px;
      g.shadowOffsetY = 14 * px;
      g.fillStyle = '#4a2e17';
      g.fillRect(D.x, D.y, D.w, D.h);
      g.restore();

      g.save();
      g.beginPath();
      g.rect(D.x, D.y, D.w, D.h);
      g.clip();

      const planks = 5;
      const ph = D.h / planks;
      for (let i = 0; i < planks; i++) {
        const y0 = D.y + i * ph;
        const hue = 24 + rnd() * 7;
        const sat = 42 + rnd() * 12;
        const lig = 30 + rnd() * 9;
        const pg = g.createLinearGradient(0, y0, 0, y0 + ph);
        pg.addColorStop(0, `hsl(${hue},${sat}%,${lig + 4}%)`);
        pg.addColorStop(0.5, `hsl(${hue},${sat}%,${lig + 1}%)`);
        pg.addColorStop(1, `hsl(${hue},${sat}%,${lig - 5}%)`);
        g.fillStyle = pg;
        g.fillRect(D.x, y0, D.w, ph);

        // Wavy grain lines
        const warpPhase = rnd() * Math.PI * 2;
        const warpAmp = 4 + rnd() * 8;
        for (let k = 0; k < 60; k++) {
          const gy = y0 + rnd() * ph;
          const amp = 0.6 + rnd() * 2.4;
          const f1 = 0.003 + rnd() * 0.008;
          const f2 = 0.02 + rnd() * 0.03;
          const p1 = rnd() * 6.28;
          const p2 = rnd() * 6.28;
          const a = 0.04 + rnd() * 0.12;
          g.strokeStyle = rnd() < 0.25 ? `rgba(255,214,160,${a * 0.7})` : `rgba(45,22,8,${a})`;
          g.lineWidth = 0.5 + rnd() * 1.8;
          g.beginPath();
          for (let x = D.x - 10; x <= D.x + D.w + 10; x += 10) {
            const y =
              gy +
              Math.sin(x * f1 + p1) * amp * 3 +
              Math.sin(x * f2 + p2) * amp * 0.5 +
              Math.sin(x * 0.0016 + warpPhase) * warpAmp;
            if (x === D.x - 10) g.moveTo(x, y);
            else g.lineTo(x, y);
          }
          g.stroke();
        }

        // Occasional knot
        if (rnd() < 0.7) {
          const kx = D.x + 80 + rnd() * (D.w - 160);
          const ky = y0 + ph * (0.3 + rnd() * 0.4);
          g.lineWidth = 1.2;
          for (let r = 7; r >= 1; r--) {
            g.strokeStyle = `rgba(50,24,8,${0.08 + (7 - r) * 0.03})`;
            g.beginPath();
            g.ellipse(kx, ky, 4 + r * 5, 1.5 + r * 1.6, 0, 0, Math.PI * 2);
            g.stroke();
          }
          g.fillStyle = 'rgba(40,18,5,0.55)';
          g.beginPath();
          g.ellipse(kx, ky, 5, 2, 0, 0, Math.PI * 2);
          g.fill();
        }

        // Butt joint and plank seam
        const jx = D.x + D.w * (0.2 + rnd() * 0.6);
        g.fillStyle = 'rgba(25,12,4,0.55)';
        g.fillRect(jx, y0, 1.5, ph);
        g.fillStyle = 'rgba(255,210,160,0.08)';
        g.fillRect(jx + 1.5, y0, 1, ph);
        g.fillStyle = 'rgba(20,10,3,0.6)';
        g.fillRect(D.x, y0 + ph - 1.5, D.w, 1.5);
        g.fillStyle = 'rgba(255,215,170,0.10)';
        g.fillRect(D.x, y0 + ph, D.w, 1);
      }

      // Varnish sheen
      const sx = D.x + D.w * 0.28;
      const sy = D.y + D.h * 0.18;
      const sheen = g.createRadialGradient(sx, sy, 10, sx, sy, D.w * 0.75);
      sheen.addColorStop(0, 'rgba(255,240,215,0.16)');
      sheen.addColorStop(0.5, 'rgba(255,240,215,0.04)');
      sheen.addColorStop(1, 'rgba(255,240,215,0)');
      g.fillStyle = sheen;
      g.fillRect(D.x, D.y, D.w, D.h);

      // Darker edges hint at the danger zone
      const vig = g.createRadialGradient(cx, cy, D.h * 0.35, cx, cy, D.w * 0.68);
      vig.addColorStop(0, 'rgba(0,0,0,0)');
      vig.addColorStop(1, 'rgba(0,0,0,0.38)');
      g.fillStyle = vig;
      g.fillRect(D.x, D.y, D.w, D.h);
      g.restore();

      // Bevelled edge lip
      g.lineWidth = 4;
      g.strokeStyle = 'rgba(30,15,5,0.85)';
      g.strokeRect(D.x + 2, D.y + 2, D.w - 4, D.h - 4);
      g.lineWidth = 1.5;
      g.strokeStyle = 'rgba(255,205,150,0.28)';
      g.strokeRect(D.x + 5, D.y + 5, D.w - 10, D.h - 10);
    }

    function buildBackground() {
      const c = document.createElement('canvas');
      c.width = canvas.width;
      c.height = canvas.height;
      const g = c.getContext('2d');
      g.setTransform(px, 0, 0, px, 0, 0);
      paintFloor(g);
      paintDesk(g);
      background = c;
    }

    /* ---------------- responsive sizing ---------------- */

    function resize() {
      // Fit inside the stage's container minus its padding (the notch / safe-area insets).
      const box = stage.parentElement;
      const cs = getComputedStyle(box);
      const innerW = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const innerH = box.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      const gutter = 16;
      const availW = Math.max(300, innerW - gutter * 2);
      const availH = Math.max(200, innerH - gutter * 2);
      const scale = Math.min(availW / VIEW.width, availH / VIEW.height);
      const cssW = Math.floor(VIEW.width * scale);
      const cssH = Math.floor(VIEW.height * scale);
      stage.style.width = cssW + 'px';
      stage.style.height = cssH + 'px';
      canvas.style.width = cssW + 'px';
      canvas.style.height = cssH + 'px';
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      px = canvas.width / VIEW.width;
      buildBackground();
    }

    /** World units per CSS pixel on screen (grows as the board shrinks). */
    function worldUnitsPerPixel() {
      return VIEW.width / canvas.getBoundingClientRect().width;
    }

    /** Converts a mouse/touch position to world coordinates. */
    function toWorld(clientX, clientY) {
      const r = canvas.getBoundingClientRect();
      return {
        x: ((clientX - r.left) * VIEW.width) / r.width,
        y: ((clientY - r.top) * VIEW.height) / r.height,
      };
    }

    /* ---------------- aiming UI ---------------- */

    function drawAim(aim, time) {
      const body = aim.pen.body;
      const def = aim.pen.def;

      // Slingshot band from the grab point to the finger
      if (aim.grab && aim.pointer) {
        ctx.save();
        ctx.lineWidth = 3;
        ctx.setLineDash([7, 6]);
        ctx.strokeStyle = 'rgba(255,255,255,0.55)';
        line(ctx, aim.grab.x, aim.grab.y, aim.pointer.x, aim.pointer.y);
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(255,255,255,0.16)';
        ctx.strokeStyle = 'rgba(255,255,255,0.75)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(aim.pointer.x, aim.pointer.y, 10, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(aim.grab.x, aim.grab.y, 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      if (!aim.valid || aim.power <= 0.001) return;

      // Curved trajectory arrow, protruding from the front of the pen in the
      // launch direction. It bends toward the side the pen will spin
      // (off-centre grab = more curl); a centre grab gives a straight arrow.
      const ux = Math.cos(aim.angle);
      const uy = Math.sin(aim.angle);
      const nx = -uy; // perpendicular (clockwise side on a y-down screen)
      const ny = ux;
      const f = PG.PhysicsModel.frontPoint(body, def, ux, uy);
      const start = { x: f.x + ux * 8, y: f.y + uy * 8 };
      const len = 55 + aim.power * 235;
      const bend = U.clamp((aim.omega || 0) * 2.6, -0.42, 0.42) * len;
      const ctrl = { x: start.x + ux * len * 0.55, y: start.y + uy * len * 0.55 };
      const end = { x: start.x + ux * len + nx * bend, y: start.y + uy * len + ny * bend };
      let tx = end.x - ctrl.x;
      let ty = end.y - ctrl.y;
      const tl = Math.hypot(tx, ty) || 1;
      tx /= tl;
      ty /= tl;
      const headLen = 22;
      const headW = 12;
      const shaftEnd = { x: end.x - tx * headLen * 0.75, y: end.y - ty * headLen * 0.75 };
      const col = U.powerColor(aim.power);

      ctx.save();
      ctx.lineCap = 'round';
      const shaft = () => {
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.quadraticCurveTo(ctrl.x, ctrl.y, shaftEnd.x, shaftEnd.y);
      };
      shaft();
      ctx.strokeStyle = 'rgba(0,0,0,0.45)';
      ctx.lineWidth = 12;
      ctx.stroke();
      const grad = ctx.createLinearGradient(start.x, start.y, end.x, end.y);
      grad.addColorStop(0, U.rgba(col, 0.15));
      grad.addColorStop(1, col);
      shaft();
      ctx.strokeStyle = grad;
      ctx.lineWidth = 7;
      ctx.stroke();

      const bx = end.x - tx * headLen;
      const by = end.y - ty * headLen;
      ctx.beginPath();
      ctx.moveTo(end.x, end.y);
      ctx.lineTo(bx - ty * headW, by + tx * headW);
      ctx.lineTo(bx + ty * headW, by - tx * headW);
      ctx.closePath();
      ctx.fillStyle = col;
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();

      drawPowerMeter(body, def, aim.power, ux, uy, time);
    }

    /**
     * Green→red bar that fills with drag distance, capped at 100%.
     * Placed beside the pen (perpendicular to the shot, toward the desk centre)
     * so it never covers the aiming arrow or the slingshot band.
     */
    function drawPowerMeter(body, def, power, ux, uy, time) {
      const w = 170;
      const h = 16;
      let nx = -uy;
      let ny = ux;
      if (nx * (D.x + D.w / 2 - body.position.x) + ny * (D.y + D.h / 2 - body.position.y) < 0) {
        nx = -nx;
        ny = -ny;
      }
      const ax = Math.cos(body.angle);
      const ay = Math.sin(body.angle);
      const penExtent =
        (def.length / 2) * Math.abs(nx * ax + ny * ay) + (def.width / 2) * Math.abs(-nx * ay + ny * ax);
      // Distance from the pen centre to the meter's centre, so its box clears the pen.
      const boxExtent = (w / 2) * Math.abs(nx) + 22 * Math.abs(ny);
      const reach = penExtent + boxExtent + 24;
      const x = U.clamp(body.position.x + nx * reach - w / 2, 8, VIEW.width - w - 8);
      const y = U.clamp(body.position.y + ny * reach - h / 2 + 8, 30, VIEW.height - h - 8);

      ctx.save();
      ctx.font = '600 13px Fredoka, "Segoe UI", sans-serif';
      ctx.textBaseline = 'bottom';
      ctx.shadowColor = 'rgba(0,0,0,0.8)';
      ctx.shadowBlur = 4 * px;
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'left';
      ctx.fillText('POWER', x, y - 5);
      ctx.textAlign = 'right';
      if (power >= 0.999) {
        ctx.fillStyle = `rgba(255,90,70,${0.55 + 0.45 * Math.sin(time * 0.02)})`;
        ctx.fillText('MAX', x + w, y - 5);
      } else {
        ctx.fillText(Math.round(power * 100) + '%', x + w, y - 5);
      }
      ctx.shadowColor = 'transparent';

      rr(ctx, x - 3, y - 3, w + 6, h + 6, (h + 6) / 2);
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.3)';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.save();
      rr(ctx, x, y, w, h, h / 2);
      ctx.clip();
      const g = ctx.createLinearGradient(x, 0, x + w, 0);
      g.addColorStop(0, '#2ecc71');
      g.addColorStop(0.5, '#f1c40f');
      g.addColorStop(1, '#e74c3c');
      ctx.fillStyle = g;
      ctx.fillRect(x, y, w * power, h);
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.fillRect(x, y, w * power, h * 0.4);
      ctx.restore();

      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 1;
      for (let i = 1; i < 4; i++) line(ctx, x + (w * i) / 4, y + 3, x + (w * i) / 4, y + h - 3);
      ctx.restore();
    }

    /* ---------------- misc overlays ---------------- */

    function drawLabel(pen) {
      const b = pen.body;
      const text = pen.owner === 'player' ? (PG.PLAYER_NAME || 'You').toUpperCase() : 'CPU';
      const x = b.position.x;
      const y = Math.max(16, b.bounds.min.y - 16);
      ctx.save();
      ctx.font = '700 12px Fredoka, "Segoe UI", sans-serif';
      const w = ctx.measureText(text).width + 16;
      rr(ctx, x - w / 2, y - 10, w, 20, 10);
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fill();
      ctx.strokeStyle = pen.colorway.accent;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, x, y + 0.5);
      ctx.restore();
    }

    function drawEffects(effects) {
      ctx.save();
      for (const e of effects) {
        const t = e.age / e.life;
        const r = 6 + U.easeOutCubic(t) * e.size;
        ctx.strokeStyle = `rgba(255,240,205,${(1 - t) * 0.85})`;
        ctx.lineWidth = 3 * (1 - t) + 0.5;
        ctx.beginPath();
        ctx.arc(e.x, e.y, r, 0, Math.PI * 2);
        ctx.stroke();
        for (let i = 0; i < 6; i++) {
          const a = e.seed + (i * Math.PI) / 3;
          line(ctx, e.x + Math.cos(a) * r * 0.55, e.y + Math.sin(a) * r * 0.55,
            e.x + Math.cos(a) * r * 1.15, e.y + Math.sin(a) * r * 1.15);
        }
      }
      ctx.restore();
    }

    /* ---------------- frame ---------------- */

    function render(scene) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#0c0b0a';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      let sx = 0;
      let sy = 0;
      if (scene.shake > 0.05) {
        sx = (Math.random() * 2 - 1) * scene.shake * px;
        sy = (Math.random() * 2 - 1) * scene.shake * px;
      }
      ctx.setTransform(px, 0, 0, px, sx, sy);
      if (background) ctx.drawImage(background, 0, 0, VIEW.width, VIEW.height);

      // Pens that have fallen off: shrink + fade as they drop to the floor.
      for (const pen of scene.pens) {
        if (!pen.off || !pen.fall) continue;
        const f = pen.fall;
        drawPenAt(ctx, pen.def, pen.colorway, f.x, f.y, f.angle, {
          scale: 1 - 0.4 * f.t,
          alpha: 1 - f.t,
          lift: 1 + 2.5 * f.t,
        });
      }

      drawEffects(scene.effects);

      const pulse = 0.65 + 0.35 * Math.sin(scene.time * 0.006);
      for (const pen of scene.pens) {
        if (pen.off) continue;
        const b = pen.body;
        drawPenAt(ctx, pen.def, pen.colorway, b.position.x, b.position.y, b.angle, {
          glow: scene.active === pen.owner ? pulse : 0,
        });
      }

      if (scene.showLabels && !scene.aim) {
        for (const pen of scene.pens) if (!pen.off) drawLabel(pen);
      }
      if (scene.aim) drawAim(scene.aim, scene.time);
    }

    /** Draws a pen centred in a small preview canvas (menu cards). */
    function drawPenPreview(cv, def, cw) {
      const c = cv.getContext('2d');
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, cv.width, cv.height);
      const s = (cv.width * 0.84) / def.length;
      c.setTransform(s, 0, 0, s, cv.width / 2 - 4 * s, cv.height / 2 - 3 * s);
      drawPenAt(c, def, cw, 0, 0, -0.06, { pxScale: s });
    }

    // Watching the container (not just the window) also catches inset changes,
    // which the Android app may report a moment after the page loads.
    new ResizeObserver(resize).observe(stage.parentElement);
    resize();

    return { render, resize, toWorld, worldUnitsPerPixel, drawPenPreview };
  };
})((window.PenGame = window.PenGame || {}));
