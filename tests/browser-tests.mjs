/* Money Handled — multi-currency BROWSER acceptance tests (zero npm deps).
 * Uses: python http.server + headless Chrome driven over the DevTools Protocol via
 * node's built-in global WebSocket (node >= 22). Fresh Chrome profile per test so
 * localStorage can't bleed between runs.
 *
 * Run: node tests/browser-tests.mjs
 * Drives the REAL intake path (files injected into #moreFiles via DOM.setFileInputFiles),
 * then asserts the FX banner, the stop-and-ask UI, the exact numbers, and 0 console errors.
 * Screenshots are written to SHOTS (scratchpad, not committed).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FIX = path.join(HERE, 'fixtures');
const PORT = 8123;
const SHOTS = process.env.MH_SHOTS || path.join(os.tmpdir(), 'mh-fx-shots');
fs.mkdirSync(SHOTS, { recursive: true });

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
if (!CHROME) { console.error('No Chrome/Edge found'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeout = 6000, interval = 100, label = 'condition' } = {}) {
  const t0 = Date.now();
  for (;;) {
    let v; try { v = await fn(); } catch { v = false; }
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error('timeout waiting for ' + label);
    await sleep(interval);
  }
}

/* ---- minimal CDP client over the global WebSocket ---- */
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = [];
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      } else if (m.method) { this.listeners.forEach((l) => l(m)); }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  on(fn) { this.listeners.push(fn); }
  async ev4(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); return r.result.value; }
}

let chromeProcs = [];
function launchChrome(port) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-chrome-'));
  const args = [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--hide-scrollbars', '--window-size=1440,2600',
    '--user-data-dir=' + profile, '--remote-debugging-port=' + port, 'about:blank',
  ];
  const proc = spawn(CHROME, args, { stdio: 'ignore' });
  chromeProcs.push({ proc, profile });
  return proc;
}
async function connect(port) {
  const list = await waitFor(async () => {
    try { const r = await fetch('http://127.0.0.1:' + port + '/json/list'); const j = await r.json(); return j.find((t) => t.type === 'page') ? j : false; }
    catch { return false; }
  }, { timeout: 12000, label: 'chrome devtools' });
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  return new CDP(ws);
}

/* ---- test harness ---- */
let failed = 0, passed = 0;
const ok = (cond, label) => { cond ? (passed++, console.log('  ✓ ' + label)) : (failed++, console.log('  ✗ ' + label)); };
const eq = (a, e, label) => ok(a === e, `${label}  (got ${JSON.stringify(a)}, want ${JSON.stringify(e)})`);

async function newPage(port) {
  launchChrome(port);
  const cdp = await connect(port);
  const jsErrors = [];
  cdp.on((m) => {
    if (m.method === 'Runtime.exceptionThrown') jsErrors.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') jsErrors.push('console.error: ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && m.params.entry.source !== 'network') jsErrors.push('log(' + m.params.entry.source + '): ' + m.params.entry.text);
  });
  await cdp.send('Runtime.enable'); await cdp.send('Log.enable'); await cdp.send('Page.enable'); await cdp.send('DOM.enable');
  const loaded = new Promise((res) => cdp.on((m) => { if (m.method === 'Page.loadEventFired') res(); }));
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });
  await loaded; await sleep(300);
  return { cdp, jsErrors };
}
async function addFiles(cdp, files) {
  const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#moreFiles' });
  await cdp.send('DOM.setFileInputFiles', { files: files.map((f) => path.join(FIX, f)), nodeId });
}
async function shot(cdp, name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const p = path.join(SHOTS, name + '.png'); fs.writeFileSync(p, Buffer.from(data, 'base64')); return p;
}

async function main() {
  const server = spawn('python', ['-m', 'http.server', String(PORT), '--directory', ROOT], { stdio: 'ignore' });
  await sleep(800);
  const shots = [];
  try {
    /* ---------- TEST A: lone CAD file, unchanged, no FX chrome ---------- */
    console.log('\nTest A — lone CAD file: no rate row, no FX banner, renders normally');
    {
      const { cdp, jsErrors } = await newPage(9301);
      await addFiles(cdp, ['test_cad.csv']);
      await waitFor(() => cdp.ev4("document.querySelectorAll('.file-row').length"), { label: 'file row' });
      eq(await cdp.ev4("document.querySelector('.file-row .fchip').textContent"), 'CAD', 'file auto-tagged CAD');
      eq(await cdp.ev4("getComputedStyle(document.getElementById('fxRateRow')).display"), 'none', 'no rate field for a CAD-only basket');
      await cdp.ev4('continueIntake()');
      await waitFor(() => cdp.ev4('!!(window.CURRENT && CURRENT.real_revenue!==undefined)'), { label: 'dashboard render' });
      eq(await cdp.ev4('CURRENT.real_revenue'), 11000, 'CAD revenue = 11,000 (unchanged behavior)');
      ok(await cdp.ev4("!document.querySelector('.fx-banner, .banner.good')") || await cdp.ev4("!/2 currencies/.test(document.body.innerText)"), 'no FX banner shown for CAD-only');
      shots.push(await shot(cdp, 'testA-cad-only'));
      eq(jsErrors.length, 0, '0 console errors' + (jsErrors.length ? ' -> ' + jsErrors.join(' | ') : ''));
    }

    /* ---------- TEST B: CAD + USD, chip auto-detect + flip, banner, exact numbers ---------- */
    console.log('\nTest B — CAD + USD: chip auto-detect, banner, revenue 11,680');
    {
      const { cdp, jsErrors } = await newPage(9302);
      await addFiles(cdp, ['test_cad.csv', 'test_usd.csv']);
      await waitFor(() => cdp.ev4("document.querySelectorAll('.file-row').length===2"), { label: 'two file rows' });
      const chips = await cdp.ev4("Array.from(document.querySelectorAll('.file-row .fchip')).map(b=>b.textContent).join(',')");
      ok(/USD/.test(chips) && /CAD/.test(chips), 'chips show both CAD and USD (test_usd.csv auto-detected USD): ' + chips);
      eq(await cdp.ev4("getComputedStyle(document.getElementById('fxRateRow')).display"), 'block', 'rate field appears when a USD file is present');
      /* prove the chip flips both ways */
      const usdIdx = await cdp.ev4("Array.from(document.querySelectorAll('.file-row .fchip')).findIndex(b=>b.textContent==='USD')");
      await cdp.ev4(`flipCur(${usdIdx})`); const flipped = await cdp.ev4(`document.querySelectorAll('.file-row .fchip')[${usdIdx}].textContent`);
      await cdp.ev4(`flipCur(${usdIdx})`); const back = await cdp.ev4(`document.querySelectorAll('.file-row .fchip')[${usdIdx}].textContent`);
      ok(flipped === 'CAD' && back === 'USD', 'currency chip flips USD->CAD->USD');
      await cdp.ev4('continueIntake()');
      await waitFor(() => cdp.ev4('!!(window.CURRENT && CURRENT.fx)'), { label: 'FX dashboard render' });
      eq(await cdp.ev4('CURRENT.real_revenue'), 11680, 'revenue = 11,680');
      eq(await cdp.ev4('CURRENT.total_out'), 5952, 'total out = 5,952');
      eq(await cdp.ev4('CURRENT.profit'), 5728, 'profit = 5,728');
      eq(await cdp.ev4('CURRENT.fx.rate_used'), 1.36, 'rate = 1.36');
      ok(await cdp.ev4("/2 currencies, 1 set of books/.test(document.body.innerText)"), 'FX banner visible: "2 currencies, 1 set of books"');
      ok(await cdp.ev4("/read from your own conversion/.test(document.body.innerText)"), 'banner names the rate source');
      ok(await cdp.ev4("/conversion counted once/.test(document.body.innerText)"), 'banner states conversion counted once');
      shots.push(await shot(cdp, 'testB-cad-usd-banner'));
      eq(jsErrors.length, 0, '0 console errors' + (jsErrors.length ? ' -> ' + jsErrors.join(' | ') : ''));
    }

    /* ---------- TEST C: USD-only, no conversion -> stop-and-ask, then rate + reload ---------- */
    console.log('\nTest C — USD-only, no conversion: stop-and-ask, then rate 1.37, then reload');
    {
      const { cdp, jsErrors } = await newPage(9303);
      await addFiles(cdp, ['test_usd_noconv.csv']);
      await waitFor(() => cdp.ev4("document.querySelectorAll('.file-row').length===1"), { label: 'usd file row' });
      await cdp.ev4('continueIntake()');            // no rate entered -> must stop and ask
      await waitFor(() => cdp.ev4("getComputedStyle(document.getElementById('fxMsg')).display!=='none'"), { label: 'stop-and-ask message' });
      ok(await cdp.ev4("!document.getElementById('addAccountsModal').classList.contains('hide')"), 'modal stays OPEN on needRate');
      ok(await cdp.ev4("!window.CURRENT || CURRENT.real_revenue===undefined || !CURRENT.fx"), 'nothing rendered on needRate');
      eq(await cdp.ev4("localStorage.getItem('mh_last_txns')"), null, 'nothing persisted on needRate');
      shots.push(await shot(cdp, 'testC-stop-and-ask'));
      await cdp.ev4("document.getElementById('fxRate').value='1.37'; continueIntake();");
      await waitFor(() => cdp.ev4('!!(window.CURRENT && CURRENT.fx && CURRENT.fx.rate_used===1.37)'), { label: 'render with user rate' });
      eq(await cdp.ev4('CURRENT.real_revenue'), 7535, 'revenue = 7,535');
      eq(await cdp.ev4('CURRENT.total_out'), 63, 'total out = 63');
      eq(await cdp.ev4('CURRENT.profit'), 7472, 'profit = 7,472');
      eq(await cdp.ev4('CURRENT.fx.rate_source'), 'the rate you entered', "source = 'the rate you entered'");
      shots.push(await shot(cdp, 'testC-user-rate'));
      /* reload: the typed rate is remembered (fxr) so init restores without asking again */
      const reloaded = new Promise((res) => cdp.on((m) => { if (m.method === 'Page.loadEventFired') res(); }));
      await cdp.send('Page.reload'); await reloaded; await sleep(400);
      await waitFor(() => cdp.ev4('!!(window.CURRENT && CURRENT.real_revenue)'), { label: 'reload restore' });
      eq(await cdp.ev4('CURRENT.real_revenue'), 7535, 'after reload, restored at 7,535 without re-asking (fxr remembered)');
      eq(jsErrors.length, 0, '0 console errors' + (jsErrors.length ? ' -> ' + jsErrors.join(' | ') : ''));
    }

    /* ---------- TEST D: a typed rate must NOT leak into a later, separate import ---------- */
    console.log('\nTest D — a rate typed in one import must not carry into the next (stale-rate regression)');
    {
      const { cdp, jsErrors } = await newPage(9304);
      /* session A: USD-only file with a conversion but no CAD leg -> needRate; type 1.50 */
      await addFiles(cdp, ['test_usd.csv']);
      await waitFor(() => cdp.ev4("document.querySelectorAll('.file-row').length===1"), { label: 'session A file' });
      await cdp.ev4('continueIntake()');
      await waitFor(() => cdp.ev4("getComputedStyle(document.getElementById('fxMsg')).display!=='none'"), { label: 'session A needRate' });
      await cdp.ev4("document.getElementById('fxRate').value='1.50'; continueIntake();");
      await waitFor(() => cdp.ev4('!!(window.CURRENT && CURRENT.fx && CURRENT.fx.rate_used===1.5)'), { label: 'session A renders at 1.50' });
      eq(await cdp.ev4('CURRENT.fx.rate_source'), 'the rate you entered', 'session A used the typed 1.50');
      /* session B: reopen ("Load another file"), drop the CAD+USD pair, run WITHOUT touching the rate */
      await cdp.ev4('openAddAccounts()');
      eq(await cdp.ev4("document.getElementById('fxRate').value"), '', 'reopening a fresh import clears the prior typed rate');
      await addFiles(cdp, ['test_cad.csv', 'test_usd.csv']);
      await waitFor(() => cdp.ev4("document.querySelectorAll('.file-row').length===2"), { label: 'session B files' });
      await cdp.ev4('continueIntake()');
      await waitFor(() => cdp.ev4('!!(window.CURRENT && CURRENT.fx && CURRENT.fx.rate_used===1.36)'), { label: 'session B realized rate' });
      eq(await cdp.ev4('CURRENT.real_revenue'), 11680, 'session B uses realized 1.36 -> revenue 11,680 (no stale 1.50)');
      eq(await cdp.ev4('CURRENT.fx.rate_source'), 'read from your own conversion', 'session B source = realized, not the stale typed rate');
      shots.push(await shot(cdp, 'testD-no-stale-rate'));
      eq(jsErrors.length, 0, '0 console errors' + (jsErrors.length ? ' -> ' + jsErrors.join(' | ') : ''));
    }
  } finally {
    for (const { proc, profile } of chromeProcs) { try { proc.kill(); } catch {} try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} }
    try { server.kill(); } catch {}
  }

  console.log('\nScreenshots:'); shots.forEach((s) => console.log('  ' + s));
  console.log('\n' + (failed === 0 ? 'BROWSER TESTS PASSED' : 'BROWSER TESTS FAILED') + `  (${passed} passed, ${failed} failed)`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error('HARNESS ERROR:', e); for (const { proc } of chromeProcs) { try { proc.kill(); } catch {} } process.exit(3); });
