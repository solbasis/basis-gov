/* ════════════════════════════════════════════════════════════════════════
   BASIS Theme Toggle — minimal cross-app theme switcher
   Hosted at https://databasis.info/design/theme.js
   Vendored or CDN-loaded by every BASIS app.

   Resolves the active theme on first paint via:
     1. localStorage('basis-theme')        — user's prior choice
     2. matchMedia('(prefers-color-scheme: light)')  — system preference
     3. fallback: dark

   Then sets <html data-theme="…"> so the CSS in tokens.css applies.

   Public API on window.BasisTheme:
     get()   → 'dark' | 'light'  — current theme
     set(t)  → void               — explicitly set theme
     toggle()→ 'dark' | 'light'   — flip and return new theme
     onChange(cb) → unsub fn      — subscribe to changes

   Usage in host app:
     <link rel="stylesheet" href="/design/tokens.css">
     <script src="/design/theme.js"></script>           // BLOCKING — must
                                                          run before paint
     <button onclick="BasisTheme.toggle()">…</button>

   The script is intentionally NOT deferred. It must execute before the
   first paint to avoid a flash of the wrong theme on reload. The script
   is tiny (~1KB) so the synchronous load cost is negligible.
   ════════════════════════════════════════════════════════════════════════ */

(() => {
  'use strict';

  if (window.BasisTheme) return;          // double-load guard

  const KEY = 'basis-theme';
  const VALID = ['dark', 'light'];
  const listeners = new Set();

  function readStored() {
    try {
      const v = localStorage.getItem(KEY);
      return VALID.includes(v) ? v : null;
    } catch { return null; }              // private mode / disabled storage
  }

  function readSystem() {
    try {
      return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    } catch { return 'dark'; }
  }

  function resolveInitial() {
    return readStored() || readSystem() || 'dark';
  }

  function apply(theme) {
    const t = VALID.includes(theme) ? theme : 'dark';
    if (document.documentElement.getAttribute('data-theme') === t) return t;
    document.documentElement.setAttribute('data-theme', t);
    return t;
  }

  function persist(theme) {
    try { localStorage.setItem(KEY, theme); } catch { /* storage disabled */ }
  }

  function emit(theme) {
    for (const fn of listeners) {
      try { fn(theme); } catch (err) {
        console.warn('[basis-theme] listener threw:', err);
      }
    }
  }

  // ── Bootstrap — runs synchronously on script load ────────────────────
  const initial = resolveInitial();
  apply(initial);

  // ── Public API ────────────────────────────────────────────────────────
  window.BasisTheme = {
    get() {
      return document.documentElement.getAttribute('data-theme') || 'dark';
    },
    set(theme) {
      const t = apply(theme);
      persist(t);
      emit(t);
      return t;
    },
    toggle() {
      const next = this.get() === 'dark' ? 'light' : 'dark';
      return this.set(next);
    },
    onChange(cb) {
      if (typeof cb !== 'function') return () => {};
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };

  // ── React to system pref changes when user hasn't explicitly chosen ──
  // If the user has stored a preference, respect it. Otherwise follow OS.
  try {
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const sysHandler = (e) => {
      if (readStored()) return;           // user chose explicitly — leave alone
      const t = e.matches ? 'light' : 'dark';
      apply(t);
      emit(t);
    };
    if (mq.addEventListener) mq.addEventListener('change', sysHandler);
    else if (mq.addListener) mq.addListener(sysHandler);  // legacy Safari
  } catch { /* matchMedia not available */ }

  // ── Cross-tab sync ────────────────────────────────────────────────────
  // If another tab on the same origin changes the theme, this tab follows.
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY || !VALID.includes(e.newValue)) return;
    apply(e.newValue);
    emit(e.newValue);
  });
})();
