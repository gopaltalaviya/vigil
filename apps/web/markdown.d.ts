export type InlineRun =
  | { type: "text" | "code" | "strong" | "em"; text: string }
  | { type: "link"; text: string; href: string };

export type Block =
  | { type: "heading"; level: number; id: string; runs: InlineRun[] }
  | { type: "paragraph"; runs: InlineRun[] }
  | { type: "quote"; runs: InlineRun[] }
  | { type: "code"; lang: string; text: string }
  | { type: "list"; ordered: boolean; items: InlineRun[][] }
  | { type: "table"; head: InlineRun[][]; rows: InlineRun[][][] }
  | { type: "rule" };

export function slug(text: string): string;
export function safeHref(href: string): string | undefined;
export function parseInline(text: string): InlineRun[];
export function parseMarkdown(source: string): Block[];
