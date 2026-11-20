export type MarkdownSpan = { type: "text" | "strong" | "code"; text: string };
export type MarkdownBlock =
  | { type: "paragraph"; spans: MarkdownSpan[] }
  | { type: "heading"; spans: MarkdownSpan[] }
  | { type: "list"; items: MarkdownSpan[][] };

export function parseMarkdown(source: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  let paragraph: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({
      type: "paragraph",
      spans: inline(paragraph.join(" ")),
    });
    paragraph = [];
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flushParagraph();
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({ type: "heading", spans: inline(heading[2] ?? "") });
      continue;
    }
    const item = /^[-*]\s+(.+)$/.exec(line);
    if (item) {
      flushParagraph();
      const last = blocks.at(-1);
      const spans = inline(item[1] ?? "");
      if (last?.type === "list") last.items.push(spans);
      else blocks.push({ type: "list", items: [spans] });
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  return blocks;
}

export function markdownToPlain(source: string): string {
  return parseMarkdown(source)
    .flatMap((block) => {
      if (block.type === "list") {
        return block.items.map((item) =>
          item.map((span) => span.text).join(""),
        );
      }
      return [block.spans.map((span) => span.text).join("")];
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function inline(source: string): MarkdownSpan[] {
  const spans: MarkdownSpan[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    if (source.startsWith("**", cursor)) {
      const end = source.indexOf("**", cursor + 2);
      if (end > cursor + 2) {
        spans.push({ type: "strong", text: source.slice(cursor + 2, end) });
        cursor = end + 2;
        continue;
      }
    }
    if (source.startsWith("`", cursor)) {
      const end = source.indexOf("`", cursor + 1);
      if (end > cursor + 1) {
        spans.push({ type: "code", text: source.slice(cursor + 1, end) });
        cursor = end + 1;
        continue;
      }
    }
    const nextBold = source.indexOf("**", cursor);
    const nextCode = source.indexOf("`", cursor);
    const candidates = [nextBold, nextCode].filter((index) => index >= 0);
    const next =
      candidates.length > 0 ? Math.min(...candidates) : source.length;
    spans.push({ type: "text", text: source.slice(cursor, next) });
    cursor = next;
  }
  return spans.filter((span) => span.text.length > 0);
}
