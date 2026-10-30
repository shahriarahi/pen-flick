/* ==========================================================================
   ai-pool.js — a small pool of Web Workers that run AI rehearsals in parallel.

   ai.js submits jobs (a shot line of the knock-out search, or one shot) and
   commits their results in order. The pool hands each idle worker the oldest
   queued job, so the earliest lines finish first. Each worker loads its own
   copy of the game's physics and AI code (ai-worker.js).

   Workers need the page to be served over http(s) — they can't start when
   index.html is opened straight from disk. If they can't start or a worker
   fails, available() turns false and ai.js does the work on the main thread.
   ========================================================================== */
(function (PG) {
  'use strict';

  const workers = []; // { worker, job } — job is the one it's running, or null
  const queue = [];
  let nextId = 1;
  let failed = false;

  function fail() {
    if (failed) return;
    failed = true;
    for (const w of workers) {
      w.worker.terminate();
      if (w.job) w.job.failed = true;
    }
    for (const job of queue) job.failed = true;
    queue.length = 0;
  }

  function feed(w) {
    while (!w.job && queue.length) {
      const job = queue.shift();
      if (job.cancelled) continue;
      w.job = job;
      w.worker.postMessage({ id: job.id, job: job.message });
    }
  }

  function start() {
    const count = Math.max(1, Math.min(PG.AI_SETTINGS.MAX_WORKERS, (navigator.hardwareConcurrency || 2) - 1));
    try {
      for (let i = 0; i < count; i++) {
        const w = { worker: new Worker('js/ai-worker.js'), job: null };
        w.worker.onmessage = (e) => {
          const job = w.job;
          w.job = null;
          if (job && job.id === e.data.id) {
            if (e.data.error) return fail();
            job.value = e.data.value;
            job.done = true;
          }
          feed(w);
        };
        w.worker.onerror = fail;
        workers.push(w);
      }
    } catch (err) {
      fail(); // e.g. index.html opened from disk
    }
  }

  PG.AIPool = {
    /** True while workers can take jobs. */
    available: () => !failed && workers.length > 0,

    /** Queues a job. Returns a handle: done + value once finished, or failed. */
    submit(message) {
      const job = { id: nextId++, message, done: false, failed: false, cancelled: false, value: null };
      if (failed) {
        job.failed = true;
        return job;
      }
      queue.push(job);
      for (const w of workers) feed(w);
      return job;
    },

    /** Drops a job that is no longer needed (a running one finishes unseen). */
    cancel(job) {
      job.cancelled = true;
      const i = queue.indexOf(job);
      if (i >= 0) queue.splice(i, 1);
    },

    /** Number of workers (0 when they couldn't start). */
    size: () => (failed ? 0 : workers.length),
  };

  if (typeof Worker === 'function') start();
})((window.PenGame = window.PenGame || {}));
