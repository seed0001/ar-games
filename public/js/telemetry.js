/**
 * Field telemetry — buffered event log shipped to POST /api/clientlog.
 *
 * Exists because the scanner's failure modes only reproduce on real phones
 * where we can't attach devtools. Events are batched and flushed every few
 * seconds with sendBeacon (which survives a frozen/killed tab), so the
 * server log shows exactly what the device was doing when it died.
 * Logging must never break the app: every path here swallows its errors.
 */

const sid = Math.random().toString(36).slice(2, 10);
let buf = [];
let timer = null;

export function tlog(ev, data) {
  try {
    buf.push({ t: Math.round(performance.now()), ev, ...data });
    if (buf.length >= 200) flush();
    else if (!timer) timer = setTimeout(flush, 3000);
  } catch (e) { /* never break the app over logging */ }
}

export function flush() {
  try {
    clearTimeout(timer);
    timer = null;
    if (!buf.length) return;
    const body = JSON.stringify({ sid, ua: navigator.userAgent, events: buf });
    buf = [];
    let sent = false;
    try {
      sent = navigator.sendBeacon?.('/api/clientlog', new Blob([body], { type: 'application/json' }));
    } catch (e) { /* beacon blocked — fall through to fetch */ }
    if (!sent) {
      fetch('/api/clientlog', {
        method: 'POST', credentials: 'same-origin', keepalive: true,
        headers: { 'Content-Type': 'application/json' }, body,
      }).catch(() => {});
    }
  } catch (e) { /* never break the app over logging */ }
}

window.addEventListener('error', (e) => {
  tlog('jserror', {
    msg: String(e.message || '').slice(0, 300),
    src: String(e.filename || '').split('/').pop() + ':' + e.lineno,
  });
  flush();
});
window.addEventListener('unhandledrejection', (e) => {
  tlog('promise-error', { msg: String(e.reason?.message || e.reason || '').slice(0, 300) });
  flush();
});
// a freeze usually ends with the user backgrounding or killing the tab —
// make sure whatever is buffered gets out at that moment
document.addEventListener('visibilitychange', () => {
  tlog('visibility', { state: document.visibilityState });
  if (document.visibilityState === 'hidden') flush();
});
window.addEventListener('pagehide', flush);

tlog('boot', {
  dpr: window.devicePixelRatio,
  screen: `${screen.width}x${screen.height}`,
  mem: navigator.deviceMemory,
  cores: navigator.hardwareConcurrency,
});
