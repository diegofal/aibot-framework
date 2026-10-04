/**
 * Per-page cleanup for the router (UX overhaul wave 2).
 *
 * app.js declares, per route handler, the destroy functions of the page it
 * renders; a handler may also return a cleanup function (or a promise of
 * one, for async pages). `leave()` runs everything registered for the page
 * being left, plus the `always` hooks, exactly once. A cleanup that resolves
 * after its page was already left runs immediately, so a slow page can never
 * leak a timer into the next one. Pure: no DOM. Tests:
 * tests/web/page-lifecycle.test.ts.
 */
export function createPageLifecycle({ always = [], onError = () => {} } = {}) {
  let pending = [];
  let generation = 0;

  const run = (fn) => {
    try {
      fn();
    } catch (err) {
      onError(err);
    }
  };

  return {
    /** Register the page just rendered: its declared destroys and the handler's return value. */
    enter(destroys, result) {
      const gen = ++generation;
      pending = (Array.isArray(destroys) ? destroys : [destroys]).filter(
        (fn) => typeof fn === 'function'
      );
      if (typeof result === 'function') {
        pending.push(result);
      } else if (result && typeof result.then === 'function') {
        result.then(
          (fn) => {
            if (typeof fn !== 'function') return;
            if (gen === generation) pending.push(fn);
            else run(fn);
          },
          () => {
            /* the page reports its own failures */
          }
        );
      }
    },
    /** Tear down the current page. Safe to call twice. */
    leave() {
      generation++;
      const list = pending;
      pending = [];
      for (const fn of list) run(fn);
      for (const fn of always) run(fn);
    },
  };
}
