/* ==========================================================================
   utils.js — small math / colour helpers shared by every module.
   All modules register themselves on the global `window.PenGame` namespace
   (classic scripts instead of ES modules so index.html also works when it is
   opened straight from disk via file://).
   ========================================================================== */
(function (PG) {
  'use strict';

  const U = (PG.util = {});

  U.clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  U.lerp = (a, b, t) => a + (b - a) * t;
  U.rand = (lo, hi) => lo + Math.random() * (hi - lo);
  U.randSign = () => (Math.random() < 0.5 ? -1 : 1);
  U.pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  U.deg2rad = (d) => (d * Math.PI) / 180;
  U.rad2deg = (r) => (r * 180) / Math.PI;
  U.easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

  /** Parses '#rgb', '#rrggbb' or 'rgb(r,g,b)' into [r, g, b]. */
  U.parseColor = function (c) {
    if (c[0] === '#') {
      let h = c.slice(1);
      if (h.length === 3) h = h.split('').map((x) => x + x).join('');
      const n = parseInt(h, 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    const m = c.match(/\d+(\.\d+)?/g);
    return m ? m.slice(0, 3).map(Number) : [0, 0, 0];
  };

  U.toHex = (rgb) =>
    '#' + rgb.map((v) => Math.round(U.clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('');

  /** amt in [-1, 1]: negative mixes toward black, positive toward white. */
  U.shade = function (color, amt) {
    const target = amt < 0 ? 0 : 255;
    const k = Math.abs(amt);
    return U.toHex(U.parseColor(color).map((v) => v + (target - v) * k));
  };

  U.rgba = function (color, a) {
    const [r, g, b] = U.parseColor(color);
    return `rgba(${r},${g},${b},${a})`;
  };

  U.mix = function (a, b, t) {
    const ca = U.parseColor(a);
    const cb = U.parseColor(b);
    return U.toHex(ca.map((v, i) => v + (cb[i] - v) * t));
  };

  /** Green -> yellow -> red ramp used by the power meter and aim arrow. */
  U.powerColor = (p) =>
    p < 0.5 ? U.mix('#2ecc71', '#f1c40f', p / 0.5) : U.mix('#f1c40f', '#e74c3c', (p - 0.5) / 0.5);

  /** Tiny seeded PRNG so the procedural wood grain looks identical every load. */
  U.mulberry32 = function (seed) {
    return function () {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
})((window.PenGame = window.PenGame || {}));
