const test = require('node:test');
const assert = require('node:assert');
const { cleanFields, parseSite, replaceText, SITE_CSP } = require('./user-projects');

test('cleanFields strips scripts and bad links from what an account sends', () => {
  const out = cleanFields({
    html: '<h2 onclick="x()">Hi</h2><script>alert(1)</script><a href="javascript:alert(1)">bad</a><img src=x onerror=y>',
    links: [{ label: 'ok', url: 'https://example.com' }, { label: 'bad', url: 'javascript:alert(1)' }],
    owner: 'someone-else',
  });
  assert.strictEqual(out.html.includes('script'), false);
  assert.strictEqual(out.html.includes('onclick'), false);
  assert.strictEqual(out.html.includes('img'), false);
  assert.deepStrictEqual(out.links, [{ label: 'ok', url: 'https://example.com' }]);
  assert.strictEqual('owner' in out, false);
});

test('parseSite accepts a whole document and rejects anything else', () => {
  const wrap = (result) => JSON.stringify({ result });
  assert.ok(parseSite(wrap('```html\n<!doctype html><html><body>Hi</body></html>\n```')).startsWith('<!doctype'));
  assert.throws(() => parseSite(wrap('Sure, here you go')));
  assert.throws(() => parseSite(wrap('<!doctype html><html><body>cut off')));
});

test('sites are always served sandboxed, with no network and no same-origin', () => {
  assert.ok(SITE_CSP.startsWith('sandbox allow-scripts'));
  assert.ok(!SITE_CSP.includes('allow-same-origin'));
  assert.ok(SITE_CSP.includes("default-src 'none'"));
});

test('replaceText edits source wording and refuses when it cannot tell which', () => {
  assert.strictEqual(replaceText('<h1>Road Trip</h1>', 'Road Trip', 'Big Trip', 0), '<h1>Big Trip</h1>');
  assert.strictEqual(replaceText('<p>Tom &amp; Jo\n  go</p>', 'Tom & Jo go', 'A <b>', 0), '<p>A &lt;b&gt;</p>');
  assert.strictEqual(replaceText('<p>Dana</p><p>Dana</p>', 'Dana', 'Lee', 1), '<p>Dana</p><p>Lee</p>');
  assert.strictEqual(replaceText('<p>Dana</p>', 'Nobody', 'Lee', 0), null);
  assert.strictEqual(replaceText('<script>var a="Hi";</script>', 'Hi', 'It\'s', 0), '<script>var a="It\\\'s";</script>');
});
