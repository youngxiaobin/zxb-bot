import { Text } from "react-native";
import { parseMarkdown, type MarkdownSpan } from "@pa/sdk";

export function MarkdownText({ source }: { source: string }) {
  const blocks = parseMarkdown(source);
  let offset = 0;
  const nodes = [];
  for (const block of blocks) {
    const key = `b${offset}`;
    offset += 1;
    if (block.type === "list") {
      for (const item of block.items) {
        const itemKey = `i${offset}`;
        offset += 1;
        nodes.push(
          <Text key={itemKey}>
            · <Spans spans={item} />
          </Text>,
        );
      }
    } else {
      nodes.push(
        <Text
          key={key}
          style={block.type === "heading" ? { fontWeight: "700" } : undefined}
        >
          <Spans spans={block.spans} />
        </Text>,
      );
    }
  }
  return nodes;
}

function Spans({ spans }: { spans: MarkdownSpan[] }) {
  let offset = 0;
  const nodes = [];
  for (const span of spans) {
    const key = `${offset}-${span.type}`;
    offset += span.text.length + 1;
    if (span.type === "strong") {
      nodes.push(
        <Text key={key} style={{ fontWeight: "700" }}>
          {span.text}
        </Text>,
      );
    } else if (span.type === "code") {
      nodes.push(
        <Text key={key} style={{ fontFamily: "monospace" }}>
          {span.text}
        </Text>,
      );
    } else {
      nodes.push(<Text key={key}>{span.text}</Text>);
    }
  }
  return nodes;
}
