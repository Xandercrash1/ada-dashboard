// error-report.js — sends this page's JavaScript errors to the server, so the nightly loop can turn real errors into
// tickets (Alex, 2026-11-25). At most 10 reports per page load, each distinct error once. Network blips and errors from
// other sites' scripts (browser extensions, outside libraries) are left out.
(function () {
  var sent = {}, count = 0;
  var SKIP = /^(Script error\.?|ResizeObserver loop|Failed to fetch|NetworkError|Load failed|The operation was aborted|AbortError)/i;
  function report(message, source, line, col, stack) {
    try {
      message = String(message || '').slice(0, 400);
      if (!message || SKIP.test(message) || count >= 10) return;
      if (source && !(source.indexOf(location.origin) === 0 || source.charAt(0) === '/')) return;
      var key = message + '|' + source + '|' + line;
      if (sent[key]) return;
      sent[key] = 1; count++;
      var body = JSON.stringify({ message: message, source: source || '', line: line || null, col: col || null,
        stack: String(stack || '').split('\n').slice(0, 4).join('\n'), page: location.pathname });
      fetch('/api/client-error', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true }).catch(function () {});
    } catch (e) { /* never let reporting break the page */ }
  }
  window.addEventListener('error', function (e) {
    if (!e || !e.message) return;   // a failed image or script load, not a code error
    report(e.message, e.filename, e.lineno, e.colno, e.error && e.error.stack);
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    report('Unhandled promise rejection: ' + (r && r.message ? r.message : String(r)), (r && r.fileName) || location.pathname, null, null, r && r.stack);
  });
})();
