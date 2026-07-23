/* Money Handled — multi-currency engine acceptance tests (zero deps: node + git only).
 * Run: node tests/engine-tests.mjs      (from the repo root)
 *
 * Loads the dashboard's inline <script> into a stubbed VM and exercises loadCSV/analyze
 * directly against Alex's locked acceptance numbers (KALVIN-FX-HANDOFF.md):
 *   Test A  a lone CAD file behaves EXACTLY as the pre-FX build (OLD-vs-NEW deep-equal)
 *   Test B  CAD + USD(tagged) -> rev 11,680 / out 5,952 / profit 5,728, rate 1.36, conversion excluded both sides
 *   Test C  USD-only minus the conversion row -> needRate stop; then rate 1.37 -> 7,535 / 63 / 7,472
 */
import fs from 'node:fs';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FIX = path.join(HERE, 'fixtures');
const readFix = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');

/* ---- a DOM/browser stub broad enough that the page's init IIFEs don't throw ---- */
function elStub() {
  const el = {
    innerHTML: '', textContent: '', value: '', className: '', children: [],
    style: { setProperty() {}, removeProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild() {}, removeChild() {}, setAttribute() {}, removeAttribute() {},
    getAttribute() { return null; }, addEventListener() {}, removeEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    click() {}, focus() {}, scrollIntoView() {}, remove() {}, parentNode: null,
  };
  return el;
}
function storageStub() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() };
}
function makeSandbox() {
  const sb = {};
  sb.window = sb; sb.globalThis = sb; sb.self = sb;
  sb.document = {
    getElementById: () => elStub(), querySelector: () => null, querySelectorAll: () => [],
    createElement: () => elStub(), addEventListener() {}, removeEventListener() {},
    body: elStub(), documentElement: elStub(),
  };
  sb.localStorage = storageStub(); sb.sessionStorage = storageStub();
  sb.console = console;
  sb.setTimeout = () => 0; sb.clearTimeout = () => {};
  sb.requestAnimationFrame = () => 0; sb.cancelAnimationFrame = () => {};
  sb.alert = () => {};
  sb.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  sb.navigator = { userAgent: 'node' };
  sb.location = { href: '', protocol: 'file:', reload() {} };
  sb.FileReader = function () {}; sb.Blob = function () {};
  sb.URL = { createObjectURL: () => '', revokeObjectURL: () => {} };
  return sb;
}
function loadEngine(html) {
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no <script> block found');
  const sb = makeSandbox();
  vm.createContext(sb);
  try { vm.runInContext(m[1], sb, { filename: 'index.html-inline' }); }
  catch (e) { /* the init IIFE may touch DOM we didn't stub — functions are hoisted, so ignore */ }
  if (typeof sb.analyze !== 'function' || typeof sb.loadCSV !== 'function')
    throw new Error('engine did not expose analyze/loadCSV');
  return sb;
}

/* ---- tiny assert harness ---- */
let failed = 0, passed = 0;
function ok(cond, label) { if (cond) { passed++; console.log('  ✓ ' + label); } else { failed++; console.log('  ✗ ' + label); } }
function eq(actual, expected, label) { ok(actual === expected, label + '  (got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected) + ')'); }

const NEW = loadEngine(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'));

/* ===================== TEST B ===================== */
console.log('\nTest B — CAD + USD statements, realized rate read from the conversion');
{
  const cad = NEW.loadCSV(readFix('test_cad.csv'), 'CAD').txns;
  const usd = NEW.loadCSV(readFix('test_usd.csv'), 'USD').txns;
  const txns = cad.concat(usd);
  txns.forEach((t) => { t._fx = false; });
  const r = NEW.analyze(txns);            // no rate arg -> realized from the matched pair
  eq(r.real_revenue, 11680, 'revenue = 11,680');
  eq(r.total_out, 5952, 'total out = 5,952');
  eq(r.profit, 5728, 'profit = 5,728');
  ok(r.real_revenue - r.total_out === r.profit, 'reconciles exactly (rev - out === profit)');
  eq(r.tax_set_aside, 1500, 'tax set aside = 1,500');
  ok(!!r.fx && r.fx.rate_used === 1.36, 'FX rate = 1.36');
  eq(r.fx && r.fx.rate_source, 'read from your own conversion', "rate source = 'read from your own conversion'");
  eq(r.fx && r.fx.pairs.length, 1, 'exactly one matched conversion pair');
  const excl = r.transfers_excluded.map((x) => x.desc);
  ok(excl.some((d) => /USD TO CAD CONVERSION/i.test(d)) && excl.some((d) => /USD CAD CONVERSION DEPOSIT/i.test(d)), 'conversion excluded on BOTH sides');
  ok(r.transactions.filter((t) => t.note && t.note.indexOf('conversion leg') === 0).length === 2, 'both legs ledgered as conversion legs');

  /* _fx-reset double-analyze: reset then re-run must be identical (the reanalyze/init guarantee) */
  txns.forEach((t) => { t._fx = false; });
  const r2 = NEW.analyze(txns);
  ok(r2.real_revenue === 11680 && r2.total_out === 5952, 'second analyze after _fx reset is identical');
  /* and prove the hazard is real: WITHOUT a reset, stale _fx flags break pairing */
  const rStale = NEW.analyze(txns);       // txns still carry _fx=true from r2
  ok(rStale.real_revenue !== 11680, 'without _fx reset the numbers change (hazard is real -> reset is required)');
}

/* ===================== TEST C ===================== */
console.log('\nTest C — USD-only, conversion row deleted: stop-and-ask, then user rate 1.37');
{
  const base = NEW.loadCSV(readFix('test_usd_noconv.csv'), 'USD').txns;
  const t1 = base.map((t) => ({ ...t, _fx: false }));
  const r1 = NEW.analyze(t1);             // no pair, no rate -> must stop and ask
  ok(r1 && r1.needRate === true, 'returns {needRate:true} (never guesses a rate)');
  const t2 = base.map((t) => ({ ...t, _fx: false }));
  const r2 = NEW.analyze(t2, 1.37);       // user-entered rate
  eq(r2.real_revenue, 7535, 'revenue = 7,535');
  eq(r2.total_out, 63, 'total out = 63');
  eq(r2.profit, 7472, 'profit = 7,472');
  ok(r2.real_revenue - r2.total_out === r2.profit, 'reconciles exactly');
  eq(r2.fx && r2.fx.rate_source, 'the rate you entered', "rate source = 'the rate you entered'");
}

/* ===================== TEST A ===================== */
console.log('\nTest A — a lone CAD run is byte-identical to the pre-FX build (OLD vs NEW)');
{
  const oldHtml = execFileSync('git', ['show', 'HEAD:index.html'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const OLD = loadEngine(oldHtml);
  const norm = (r) => { const c = { ...r }; delete c.fx; return JSON.stringify(c); };

  // (1) the built-in demo sample
  const newSample = NEW.analyze(NEW.loadCSV(NEW.SAMPLE_CSV).txns);
  const oldSample = OLD.analyze(OLD.loadCSV(OLD.SAMPLE_CSV).txns);
  ok(newSample.fx === null, 'CAD-only sample has fx === null');
  ok(norm(newSample) === norm(oldSample), 'sample: NEW analyze === OLD analyze (fx stripped)');

  // (2) a real lone CAD file
  const cadText = readFix('test_cad.csv');
  const newCad = NEW.analyze(NEW.loadCSV(cadText, 'CAD').txns);
  const oldCad = OLD.analyze(OLD.loadCSV(cadText).txns);
  ok(newCad.fx === null, 'CAD-only file has fx === null');
  ok(norm(newCad) === norm(oldCad), 'test_cad.csv: NEW analyze === OLD analyze (fx stripped)');
  eq(newCad.real_revenue, oldCad.real_revenue, 'headline revenue unchanged vs OLD build');
}

console.log('\n' + (failed === 0 ? 'ENGINE TESTS PASSED' : 'ENGINE TESTS FAILED') + '  (' + passed + ' passed, ' + failed + ' failed)');
process.exit(failed === 0 ? 0 : 1);
