// A small, safe Markdown reader for the docs pages. It parses into a plain tree
// of blocks and inline runs; the app turns that tree into DOM nodes with
// textContent. No HTML in the source is ever interpreted, and links are kept
// only when they point to http(s), a relative path, or an in-page anchor.

/** Turns a heading into an anchor id: lower-case words joined by hyphens. */
export function slug(text) {
  return text
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Whether a link target is safe to follow. */
export function safeHref(href) {
  const target = href.trim();
  if (/^https?:\/\//i.test(target)) return target;
  if (/^#[\w-]*$/.test(target)) return target;
  // Relative paths only; "//host" would leave the site.
  if (/^[\w./-]+(#[\w-]*)?$/.test(target) && !target.startsWith("//")) return target;
  return undefined;
}

/** Parses inline Markdown: `code`, **bold**, *italic*, [text](href). */
export function parseInline(text) {
  const runs = [];
  const pattern =
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) runs.push({ type: "text", text: text.slice(last, match.index) });
    const token = match[0];
    if (match[1]) runs.push({ type: "code", text: token.slice(1, -1) });
    else if (match[2]) runs.push({ type: "strong", text: token.slice(2, -2) });
    else if (match[3]) runs.push({ type: "em", text: token.slice(1, -1) });
    else {
      const [, label, href] = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      const safe = safeHref(href);
      runs.push(
        safe === undefined
          ? { type: "text", text: label }
          : { type: "link", text: label, href: safe },
      );
    }
    last = match.index + token.length;
  }
  if (last < text.length) runs.push({ type: "text", text: text.slice(last) });
  return runs;
}

const splitRow = (line) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());

/** Parses a Markdown document into blocks. */
export function parseMarkdown(source) {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const code = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) code.push(lines[i++]);
      i += 1;
      blocks.push({ type: "code", lang: fence[1], text: code.join("\n") });
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const text = heading[2].trim();
      blocks.push({
        type: "heading",
        level: heading[1].length,
        id: slug(text),
        runs: parseInline(text),
      });
      i += 1;
      continue;
    }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const head = splitRow(line).map(parseInline);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i]))
        rows.push(splitRow(lines[i++]).map(parseInline));
      blocks.push({ type: "table", head, rows });
      continue;
    }
    const item = /^\s*([-*]|\d+\.)\s+(.*)$/.exec(line);
    if (item) {
      const ordered = /\d/.test(item[1]);
      const items = [];
      while (i < lines.length) {
        const next = /^\s*([-*]|\d+\.)\s+(.*)$/.exec(lines[i]);
        if (next) {
          items.push(next[2]);
          i += 1;
        } else if (/^\s{2,}\S/.test(lines[i]) && items.length > 0) {
          items[items.length - 1] += ` ${lines[i].trim()}`;
          i += 1;
        } else break;
      }
      blocks.push({ type: "list", ordered, items: items.map(parseInline) });
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quote = [];
      while (i < lines.length && /^>\s?/.test(lines[i]))
        quote.push(lines[i++].replace(/^>\s?/, ""));
      blocks.push({ type: "quote", runs: parseInline(quote.join(" ")) });
      continue;
    }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      blocks.push({ type: "rule" });
      i += 1;
      continue;
    }
    const paragraph = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^(#{1,4}\s|```|\s*([-*]|\d+\.)\s|>|\s*\|)/.test(lines[i])
    ) {
      paragraph.push(lines[i++].trim());
    }
    if (paragraph.length === 0) {
      // A line no rule above accepted (for example a lone "<p>"): show it as text.
      paragraph.push(lines[i++].trim());
    }
    blocks.push({ type: "paragraph", runs: parseInline(paragraph.join(" ")) });
  }
  return blocks;
}
