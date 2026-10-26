# Pen Flick — Desk Duel

A 2D top-down pen-flicking game for the browser, built with HTML5 Canvas and the [Matter.js](https://brm.io/matter-js/) physics engine.

Flick your pen into the computer's pen and knock it off the desk — but if your **own** pen slides off, you lose instantly.

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
- **Three AI difficulties:**
  - *Easy* aims roughly (up to 20° off) with random force.
  - *Medium* computes the exact angle, then misses by 1–5°, with moderate force.
  - *Hard* fires along the centre-of-mass line and computes the exact force needed to push your pen off.
    It checks that force by rehearsing the shot in a hidden copy of the physics world.
- Turn-based play: input is locked until both pens come to a complete stop.

## Project structure

```
index.html      page, menus and HUD
style.css       UI styling
js/utils.js     math and colour helpers
js/config.js    ALL tuning: pen physics, flick strength, AI settings, player name
js/physics.js   Matter.js world, pen bodies, flick impulses, desk-edge sensor
js/renderer.js  canvas drawing: desk, pens, aiming UI, effects
js/input.js     slingshot drag input (mouse, pen and touch)
js/ai.js        computer opponent
js/main.js      turn state machine, game loop, menus
```

## Tuning

Everything adjustable lives in [`js/config.js`](js/config.js), with comments explaining each Matter.js parameter.
For example, `frictionAir` acts as desk friction in this top-down view, and a pen slides roughly
`launch speed / frictionAir` units before it stops.
