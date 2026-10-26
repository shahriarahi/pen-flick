# Pen Flick — Desk Duel

A 2D top-down pen-flicking game for the browser, built with HTML5 Canvas and the [Matter.js](https://brm.io/matter-js/) physics engine.

Flick your pen into the computer's pen and knock it off the desk — but if your **own** pen slides off, you lose instantly.
Like a real pen, a pen falls as soon as more than half of it hangs over the edge.

## Play

Download or clone the repo and open `index.html` in a modern browser. No build step or server is needed.
An internet connection is required (Matter.js and the font load from a CDN).

**Controls:** press on your pen, drag **backwards** like a slingshot, and release.
Grab near the ends of the pen to add spin. `Esc` or right-click cancels a shot.

## Features

- **Six pens with different physics:** Standard Ballpoint, Heavy Fountain Pen, Lightweight Marker,
  Clicky Gel Pen, Wooden Pencil and Tactical Metal Pen. Each has its own mass, desk friction, bounce and reach.
- **Realistic rendering:** canvas gradients, metallic parts and soft shadows, lit consistently as pens rotate,
  on a procedurally generated wooden desk.
- **Slingshot aiming:** a curved arrow that shows launch direction and spin, plus a green-to-red power meter.
- **Three AI difficulties.** Medium and Hard pick their shots by rehearsing them in a hidden copy of
  the physics world. The simulation is deterministic, so each rehearsal previews the real shot exactly.
  - *Easy* aims roughly (up to 12° off) with a hit-or-miss force, and avoids flicking its own pen off.
  - *Medium* rehearses a small set of shots near the centre line to find a knockout, otherwise it plays a
    safe push. Its aim and force wobble slightly.
  - *Hard* searches angled and spinning shots for a knockout. If none exists, it scores the positions its
    shots would leave and checks the best ones against your possible replies. Then it plays a position you
    can't knock it off from, if one exists.
- **Fair starts:** the first move alternates between you and the computer. The starting layout is re-rolled
  until the first shooter has no knockout on the opening shot.
- Turn-based play: input is locked until both pens come to a complete stop.

## Project structure

```
index.html      page, menus and HUD
style.css       UI styling
js/utils.js     math and colour helpers
js/config.js    ALL tuning: pen physics, flick strength, AI settings, player name
js/physics.js   Matter.js world, pen bodies, flick impulses, fall-off test
js/renderer.js  canvas drawing: desk, pens, aiming UI, effects
js/input.js     slingshot drag input (mouse, pen and touch)
js/ai.js        computer opponent
js/main.js      turn state machine, game loop, menus
```

## Tuning

Everything adjustable lives in [`js/config.js`](js/config.js), with comments explaining each Matter.js parameter.
For example, `frictionAir` acts as desk friction in this top-down view, and a pen slides roughly
`launch speed / frictionAir` units before it stops.
