// Small, dependency-free Markdown renderer. Every piece of text is HTML-escaped
// before it is wrapped in a tag, and link targets are restricted to http(s)/mailto.
// The output is still inserted through DOMParser in the UI, never via innerHTML.

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
const unesc = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

function safeUrl(u) {
  try {
    const x = new URL(u);
    return ["http:", "https:", "mailto:"].includes(x.protocol) ? x.href : null;
  } catch {
    return null;
  }
}

function inline(text) {
  const stash = [];
  const hold = (html) => `\u0000${stash.push(html) - 1}\u0000`;
  text = text.replace(/`([^`\n]+)`/g, (_, c) => hold(`<code>${esc(c)}</code>`));
  text = esc(text);
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, (m, t, u) => {
    const safe = safeUrl(unesc(u));
    return safe ? hold(`<a href="${esc(safe)}" target="_blank" rel="noopener noreferrer">${t}</a>`) : m;
  });
  text = text.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  text = text.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
  return text.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[Number(i)]);
}

const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const FENCE_RE = /^\s*(```|~~~)\s*([\w+#.-]*)/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const HR_RE = /^\s*([-*_])\s*(\1\s*){2,}$/;

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

function startsBlock(lines, i) {
  const l = lines[i];
  return (
    FENCE_RE.test(l) ||
    /^(#{1,6})\s+/.test(l) ||
    LIST_RE.test(l) ||
    /^\s*>/.test(l) ||
    HR_RE.test(l) ||
    (l.includes("|") && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]))
  );
}

function parseList(lines, start) {
  const first = lines[start].match(LIST_RE);
  const base = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items = [];
  let i = start;
  while (i < lines.length) {
    const m = lines[i].match(LIST_RE);
    if (!m || m[1].length !== base || /\d/.test(m[2]) !== ordered) break;
    const sub = [];
    const text = m[3];
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) {
        let j = i;
        while (j < lines.length && !lines[j].trim()) j++;
        if (j < lines.length && lines[j].search(/\S/) > base) {
          sub.push("");
          i++;
          continue;
        }
        break;
      }
      if (l.search(/\S/) > base) {
        sub.push(l.slice(Math.min(l.search(/\S/), base + 2)));
        i++;
        continue;
      }
      break;
    }
    items.push(`<li>${inline(text)}${sub.length ? renderMarkdown(sub.join("\n")) : ""}</li>`);
    while (i < lines.length && !lines[i].trim() && i + 1 < lines.length && LIST_RE.test(lines[i + 1])) i++;
  }
  const tag = ordered ? "ol" : "ul";
  return { html: `<${tag}>${items.join("")}</${tag}>`, next: i };
}

export function renderMarkdown(src) {
  const lines = String(src).replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    let m = line.match(FENCE_RE);
    if (m) {
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(m[1])) buf.push(lines[i++]);
      i++; // closing fence (absent while streaming: the block simply stays open)
      const cls = m[2] ? ` class="lang-${esc(m[2])}"` : "";
      out.push(`<pre><code${cls}>${esc(buf.join("\n"))}</code></pre>`);
      continue;
    }

    m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      out.push(`<h${m[1].length}>${inline(m[2].replace(/\s+#+\s*$/, ""))}</h${m[1].length}>`);
      i++;
      continue;
    }

    if (HR_RE.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) rows.push(splitRow(lines[i++]));
      const th = head.map((c) => `<th>${inline(c)}</th>`).join("");
      const tr = rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("");
      out.push(`<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`);
      continue;
    }

    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${renderMarkdown(buf.join("\n"))}</blockquote>`);
      continue;
    }

    if (LIST_RE.test(line)) {
      const r = parseList(lines, i);
      out.push(r.html);
      i = r.next;
      continue;
    }

    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) buf.push(lines[i++]);
    out.push(`<p>${buf.map(inline).join("<br>")}</p>`);
  }
  return out.join("");
}

// Parse an HTML string into inert nodes and put them into `container`.
export function setHTML(container, html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  container.replaceChildren(...doc.body.childNodes);
}
