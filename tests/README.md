# Multi-currency (USD + CAD) acceptance tests

Zero-dependency harness — **Node + Chrome + git only**, no `npm install`. Run from the repo root:

```bash
node tests/engine-tests.mjs     # exact-number acceptance (A/B/C) + OLD-vs-NEW regression, no browser
node tests/browser-tests.mjs    # real intake path in headless Chrome + 0 console errors + screenshots
```

- `engine-tests.mjs` loads `index.html`'s inline `<script>` into a stubbed VM and calls `loadCSV`/`analyze` directly. It also loads the pre-FX build via `git show HEAD:index.html` to prove a lone CAD file is byte-identical.
- `browser-tests.mjs` serves the folder with `python -m http.server` and drives Chrome over the DevTools Protocol (fresh profile per test). Screenshots go to `$MH_SHOTS` (default: OS temp) and are **not** committed.
- `fixtures/` holds the canonical CSVs from Alex's FX handoff (`KALVIN-FX-HANDOFF.md`).

**Acceptance (must stay green):** Test B → revenue 11,680 / out 5,952 / profit 5,728 at rate 1.36; Test C → `needRate` stop, then 1.37 → 7,535 / 63 / 7,472; Test A → lone CAD unchanged; Test D → a typed rate never leaks into a later import.
