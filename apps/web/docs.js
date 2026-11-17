// The Docs section: the Markdown files from the repository's docs folder,
// rendered with the safe parser in markdown.js.
import { parseMarkdown } from "./markdown.js";

export const DOC_PAGES = [
  ["CONCEPT", "Concept"],
  ["USER_GUIDE", "Using the web app"],
  ["CLI", "Command line"],
  ["API", "HTTP API"],
  ["CONFIGURATION", "Configuration"],
  ["CONTRACT", "Receipts contract"],
  ["ARCHITECTURE", "Architecture"],
  ["THREAT_MODEL", "Threat model"],
  ["RUNBOOK", "Running Vigil"],
  ["JUDGES", "For judges"],
];

const cache = new Map();

async function fetchDoc(name) {
  if (cache.has(name)) return cache.get(name);
  const response = await fetch(`/docs/${name}.md`, { cache: "no-cache" });
  if (!response.ok)
    throw Object.assign(new Error("This page is not available."), { status: response.status });
  const text = await response.text();
  cache.set(name, text);
  return text;
}

function inline(el, runs) {
  return runs.map((run) => {
    switch (run.type) {
      case "code":
        return el("code", { text: run.text });
      case "strong":
        return el("strong", { text: run.text });
      case "em":
        return el("em", { text: run.text });
      case "link": {
        // Links between docs stay inside the app.
        const doc = /^([A-Z_]+)\.md(#[\w-]*)?$/.exec(run.href);
        const href = doc && DOC_PAGES.some(([id]) => id === doc[1]) ? `#/docs/${doc[1]}` : run.href;
        const external = /^https?:/.test(href);
        return el("a", {
          href,
          text: run.text,
          target: external ? "_blank" : undefined,
          rel: external ? "noopener noreferrer" : undefined,
        });
      }
      default:
        return document.createTextNode(run.text);
    }
  });
}

/** Builds DOM nodes from parsed Markdown. Every string is set as text. */
export function renderMarkdown(el, source) {
  return parseMarkdown(source).map((block) => {
    switch (block.type) {
      case "heading": {
        // The page title is the app's own h1, so document headings start at h2.
        const level = Math.min(4, Math.max(2, block.level));
        return el(`h${level}`, { id: `doc-${block.id}` }, inline(el, block.runs));
      }
      case "code":
        return el("pre", { className: "code" }, el("code", { text: block.text }));
      case "table":
        return el(
          "div",
          { className: "table-wrap", role: "region", "aria-label": "Table", tabindex: "0" },
          el("table", {}, [
            el(
              "thead",
              {},
              el(
                "tr",
                {},
                block.head.map((cell) => el("th", { scope: "col" }, inline(el, cell))),
              ),
            ),
            el(
              "tbody",
              {},
              block.rows.map((row) =>
                el(
                  "tr",
                  {},
                  row.map((cell) => el("td", { className: "wrap" }, inline(el, cell))),
                ),
              ),
            ),
          ]),
        );
      case "list":
        return el(
          block.ordered ? "ol" : "ul",
          { className: "prose-list" },
          block.items.map((runs) => el("li", {}, inline(el, runs))),
        );
      case "quote":
        return el("blockquote", {}, inline(el, block.runs));
      case "rule":
        return el("hr");
      default:
        return el("p", {}, inline(el, block.runs));
    }
  });
}

export function docsView({ el }) {
  return {
    title: "Docs",
    async load(param) {
      const name = DOC_PAGES.some(([id]) => id === param) ? param : "CONCEPT";
      return { name, text: await fetchDoc(name) };
    },
    render(data) {
      const title = DOC_PAGES.find(([id]) => id === data.name)[1];
      const nav = el(
        "nav",
        { className: "side-nav", "aria-label": "Docs" },
        el(
          "ul",
          {},
          DOC_PAGES.map(([id, label]) =>
            el(
              "li",
              {},
              el("a", {
                href: `#/docs/${id}`,
                text: label,
                "aria-current": id === data.name ? "page" : undefined,
              }),
            ),
          ),
        ),
      );
      // The document's own first heading repeats the page title, so it is dropped.
      const body = renderMarkdown(el, data.text.replace(/^#\s+.*\n+/, ""));
      return el("div", { className: "stack" }, [
        el("div", { className: "page-head" }, [el("h1", { text: title })]),
        el("div", { className: "with-side" }, [
          nav,
          el("article", { className: "prose docs" }, body),
        ]),
      ]);
    },
  };
}
