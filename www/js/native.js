/* ==========================================================================
   native.js — glue for the Android app (Capacitor).

   In the Android app, Capacitor's native bridge provides window.Capacitor and
   the App plugin (vendor/capacitor-app.js) reports the hardware back button.
   In a normal browser none of that fires, and PG.native.isApp is false.

   Phones have no Esc key or right-click, so the back button takes over the
   "cancel" job: main.js registers a handler with PG.native.onBack().
   ========================================================================== */
(function (PG) {
  'use strict';

  const cap = window.Capacitor;
  const isApp = !!(cap && cap.isNativePlatform && cap.isNativePlatform());
  const App = isApp && window.capacitorApp ? window.capacitorApp.App : null;

  PG.native = {
    /** True when running inside the Android app rather than a browser. */
    isApp,

    /**
     * Calls `handler` on every back-button press. The handler returns true if
     * it used the press; otherwise the app goes to the background, which is
     * what back does on an Android home screen.
     */
    onBack(handler) {
      if (!App) return;
      App.addListener('backButton', () => {
        if (!handler()) App.minimizeApp();
      });
    },
  };
})((window.PenGame = window.PenGame || {}));
