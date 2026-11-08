import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../extension/lib/markdown.js";

test("escapes raw HTML in text, code and headings", () => {
  const h = renderMarkdown('# <img src=x onerror=alert(1)>\n\n<script>alert(1)</script>\n\n`<b>`\n\n```\n<script>x</script>\n```');
  assert.ok(!/<script|<img/i.test(h), h);
  assert.ok(h.includes("&lt;script&gt;"));
});

test("only http, https and mailto links survive", () => {
  const bad = renderMarkdown("[x](javascript:alert(1)) [y](data:text/html,hi)");
  assert.ok(!bad.includes("<a "), bad);
  const good = renderMarkdown("[ok](https://example.com/a?b=1&c=2)");
  assert.ok(good.includes('href="https://example.com/a?b=1&amp;c=2"'), good);
  assert.ok(good.includes('rel="noopener noreferrer"'));
});

test("quotes in a URL cannot break out of the attribute", () => {
  const h = renderMarkdown('[x](https://a.com/"onmouseover="alert(1))');
  assert.ok(!/onmouseover="/.test(h.replace(/&quot;/g, "")), h);
  assert.ok(!/ onmouseover=/.test(h), h);
});

test("bold, italic, inline code, strike", () => {
  assert.equal(renderMarkdown("**b** *i* `c` ~~s~~"), "<p><strong>b</strong> <em>i</em> <code>c</code> <del>s</del></p>");
});

test("snake_case and stars in code are left alone", () => {
  assert.equal(renderMarkdown("use my_var_name and `a*b*c`"), "<p>use my_var_name and <code>a*b*c</code></p>");
});

test("unterminated fence (mid-stream) renders as an open code block", () => {
  const h = renderMarkdown("Here:\n\n```js\nconst a = 1;");
  assert.ok(h.includes('<pre><code class="lang-js">const a = 1;</code></pre>'), h);
});

test("lists, nested lists and ordered lists", () => {
  const h = renderMarkdown("- a\n- b\n  - c\n\n1. one\n2. two");
  assert.equal(h, "<ul><li>a</li><li>b<ul><li>c</li></ul></li></ul><ol><li>one</li><li>two</li></ol>");
});

test("tables", () => {
  const h = renderMarkdown("| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | <i>4</i> |");
  assert.ok(h.includes("<th>A</th><th>B</th>"));
  assert.ok(h.includes("<td>3</td><td>&lt;i&gt;4&lt;/i&gt;</td>"));
});

test("blockquote, hr, headings, paragraph line breaks", () => {
  assert.equal(renderMarkdown("> q"), "<blockquote><p>q</p></blockquote>");
  assert.equal(renderMarkdown("---"), "<hr>");
  assert.equal(renderMarkdown("## T"), "<h2>T</h2>");
  assert.equal(renderMarkdown("a\nb"), "<p>a<br>b</p>");
});

test("pathological input does not hang", () => {
  const t = Date.now();
  renderMarkdown("*".repeat(20000) + "\n" + "[".repeat(5000) + "\n" + "|".repeat(5000));
  assert.ok(Date.now() - t < 2000);
});

import { mdToPlain } from "../extension/lib/markdown.js";
test("mdToPlain strips markup and keeps link URLs", () => {
  const out = mdToPlain("## Title\n\n**bold** and `code` [site](https://a.com)\n\n- one\n- two");
  assert.ok(!out.includes("##") && !out.includes("**") && !out.includes("`"));
  assert.ok(out.includes("site (https://a.com)"));
  assert.ok(out.includes("one") && out.includes("two"));
});
