// Security tests for Document widget HTML cleaning. Run: node src/doc-html.test.js
const assert = require('assert');
const { cleanDocHtml, DOC_ID_RE } = require('./doc-html');
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('PASS ', name); } catch (e) { fail++; console.log('FAIL ', name, '—', e.message); } };

// --- Document widget rich text (Quill HTML) ---
const D = h => cleanDocHtml(h);
['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '<a href="javascript:alert(1)">x</a>', '<p onclick="x">x</p>',
 '<iframe src="https://x"></iframe>', '<p style="background:url(javascript:alert(1))">x</p>', '<p class="evil">x</p>', '<svg onload=alert(1)>',
 '<img src="data:image/png;base64,AAAA">', '<span style="color:expression(alert(1))">x</span>'].forEach((a, i) =>
  t(`doc: attack ${i + 1} neutralised  ${a.slice(0, 40)}`, () => {
    const out = D(a);
    assert(!/<script|onerror|onclick|onload|javascript:|<iframe|<svg|expression|data:image|class="evil"/i.test(out), 'got: ' + out);
  }));
t('doc: Quill formatting survives', () => {
  const h = '<h2 class="ql-align-center">T</h2><p><strong>b</strong> <em>i</em> <u>u</u> <s>s</s> <span class="ql-font-serif ql-size-large" style="color: rgb(230, 0, 0); background-color: #ffff00;">c</span></p>'
    + '<ol><li data-list="bullet" class="ql-indent-1">x</li><li data-list="checked">y</li></ol><blockquote>q</blockquote>'
    + '<div class="ql-code-block-container"><div class="ql-code-block">code</div></div><p><a href="https://x.com" target="_blank">l</a><img src="/media/a.webp"></p>';
  const out = D(h);
  for (const want of ['class="ql-align-center"', 'ql-font-serif', 'color:rgb(230, 0, 0)', 'background-color:#ffff00', 'data-list="checked"', 'ql-indent-1', 'ql-code-block', 'rel="noopener noreferrer"', 'src="/media/a.webp"', '<blockquote>'])
    assert(out.includes(want), 'missing ' + want + ' in ' + out);
});
t('doc ids: paths refused', () => { for (const bad of ['../x', '..%2Fx', 'a/b', '', 'x'.repeat(65)]) assert(!DOC_ID_RE.test(bad), bad); assert(DOC_ID_RE.test('doctest-1') && DOC_ID_RE.test('old_11')); });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
