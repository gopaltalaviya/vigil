import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown, safeHref, slug } from "../../../apps/web/markdown.js";

describe("Markdown parser used by the docs pages", () => {
  it("parses headings, paragraphs, lists, tables, code, quotes and rules", () => {
    const blocks = parseMarkdown(
      [
        "# Title",
        "",
        "Some **bold** and `code` and a [link](API.md).",
        "",
        "- one",
        "- two",
        "  continued",
        "",
        "1. first",
        "2. second",
        "",
        "| A | B |",
        "| --- | --- |",
        "| x | `y` |",
        "",
        "```sh",
        "pnpm test",
        "```",
        "",
        "> a note",
        "",
        "---",
      ].join("\n"),
    );
    expect(blocks.map((b) => b.type)).toEqual([
      "heading",
      "paragraph",
      "list",
      "list",
      "table",
      "code",
      "quote",
      "rule",
    ]);
    expect(blocks[0]).toMatchObject({ level: 1, id: "title" });
    expect(blocks[2]).toMatchObject({ ordered: false });
    expect(blocks[2]?.type === "list" && blocks[2].items[1]?.[0]?.text).toBe("two continued");
    expect(blocks[3]).toMatchObject({ ordered: true });
    expect(blocks[5]).toMatchObject({ lang: "sh", text: "pnpm test" });
  });

  it("keeps inline formatting as separate runs", () => {
    expect(parseInline("a **b** *c* `d` [e](https://x.example)")).toEqual([
      { type: "text", text: "a " },
      { type: "strong", text: "b" },
      { type: "text", text: " " },
      { type: "em", text: "c" },
      { type: "text", text: " " },
      { type: "code", text: "d" },
      { type: "text", text: " " },
      { type: "link", text: "e", href: "https://x.example" },
    ]);
  });

  it("never turns HTML into anything but text", () => {
    const blocks = parseMarkdown('<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">');
    expect(blocks).toEqual([
      { type: "paragraph", runs: [{ type: "text", text: "<script>alert(1)</script>" }] },
      { type: "paragraph", runs: [{ type: "text", text: '<img src=x onerror="alert(1)">' }] },
    ]);
  });

  it("drops links to dangerous schemes but keeps their text", () => {
    for (const href of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "data:text/html,x",
      "vbscript:x",
      "//evil.example",
    ]) {
      expect(safeHref(href), href).toBeUndefined();
      const runs = parseInline(`[click](${href})`);
      expect(
        runs.some((run) => run.type === "link"),
        href,
      ).toBe(false);
      expect(runs.map((run) => run.text).join(""), href).toContain("click");
    }
    expect(safeHref("https://qorechain.io")).toBe("https://qorechain.io");
    expect(safeHref("#limits")).toBe("#limits");
    expect(safeHref("THREAT_MODEL.md")).toBe("THREAT_MODEL.md");
  });

  it("copes with very long lines and unclosed code fences", () => {
    const long = "x".repeat(200_000);
    expect(parseMarkdown(long)).toHaveLength(1);
    expect(parseMarkdown("```\nnever closed")).toEqual([
      { type: "code", lang: "", text: "never closed" },
    ]);
  });

  it("makes stable anchor ids", () => {
    expect(slug("How a `transaction` settles!")).toBe("how-a-transaction-settles");
  });

  it("parses every document the app serves", () => {
    const dir = new URL("../../../docs/", import.meta.url);
    for (const name of readdirSync(dir).filter((file) => file.endsWith(".md"))) {
      const blocks = parseMarkdown(readFileSync(new URL(name, dir), "utf8"));
      expect(blocks.length, name).toBeGreaterThan(3);
      expect(blocks[0]?.type, name).toBe("heading");
    }
  });
});
