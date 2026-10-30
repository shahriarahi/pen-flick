/* ==========================================================================
   ai-worker.js — a Web Worker that runs AI rehearsals off the main thread.

   It loads the same physics and AI code as the page. The modules register on
   `window.PenGame`, and a worker has no `window`, so `self` stands in for it.
   Matter.js gives identical results here and on the main thread, so a
   worker's rehearsal is exactly the one the main thread would have run.
   ========================================================================== */
self.window = self;
importScripts('../vendor/matter.min.js', 'utils.js', 'config.js', 'physics.js', 'ai.js');

self.onmessage = (e) => {
  const { id, job } = e.data;
  try {
    self.postMessage({ id, value: self.PenGame.AI.runJob(job) });
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};
