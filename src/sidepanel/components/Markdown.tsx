import { useState } from "react";

// Minimal markdown-ish renderer (docs/ui-spec.md §3.2).
// v1 scope: paragraphs, headings (h1–h4; h5/h6 fold to h4), ordered/unordered
// lists, blockquotes, fenced code blocks with a copy button, inline code,
// bold, italic, and links. Heavy deps are avoided intentionally — a future
// maintainer can swap this for `marked` / `markdown-it` if scope grows.

interface Props {
  text: string;
  /** When true, renders a blinking caret after the content (streaming cue). */
  streaming?: boolean;
}

interface TextSegment {
  kind: "text";
  value: string;
}
interface CodeSegment {
  kind: "code";
  lang: string;
  value: string;
}
type Segment = TextSegment | CodeSegment;

function splitFencedCode(input: string): Segment[] {
  const result: Segment[] = [];
  const re = /```([^\n`]*)\n([\s\S]*?)(?:```|$)/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    if (m.index > lastIndex) {
      result.push({ kind: "text", value: input.slice(lastIndex, m.index) });
    }
    result.push({ kind: "code", lang: m[1].trim(), value: m[2] });
    lastIndex = re.lastIndex;
  }
  if (lastIndex < input.length) {
    result.push({ kind: "text", value: input.slice(lastIndex) });
  }
  return result;
}

function renderInline(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let i = 0;
  let keyCounter = 0;
  const push = (node: React.ReactNode) => nodes.push(node);

  const inlineRe =
    /(`([^`\n]+)`)|(\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\))|(\*\*([^*\n]+)\*\*)|(\*([^*\n]+)\*)/g;

  let match: RegExpExecArray | null;
  while ((match = inlineRe.exec(text)) !== null) {
    if (match.index > i) {
      push(text.slice(i, match.index));
    }
    if (match[1]) {
      push(
        <code key={`c-${keyCounter++}`} className="md-code-inline">
          {match[2]}
        </code>,
      );
    } else if (match[3]) {
      push(
        <a
          key={`a-${keyCounter++}`}
          href={match[5]}
          target="_blank"
          rel="noopener noreferrer"
        >
          {match[4]}
        </a>,
      );
    } else if (match[6]) {
      push(<strong key={`b-${keyCounter++}`}>{match[7]}</strong>);
    } else if (match[8]) {
      push(<em key={`i-${keyCounter++}`}>{match[9]}</em>);
    }
    i = inlineRe.lastIndex;
  }
  if (i < text.length) {
    push(text.slice(i));
  }
  return nodes;
}

function CodeBlock({ lang, value }: { lang: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked — surface nothing; user can still select manually.
    }
  };
  return (
    <div className="md-code-block">
      <div className="md-code-block__header">
        <span className="md-code-block__lang">{lang || "code"}</span>
        <button
          type="button"
          className="md-code-block__copy"
          onClick={onCopy}
          aria-label={copied ? "Copied" : "Copy code"}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>
        <code>{value}</code>
      </pre>
    </div>
  );
}

type Block =
  | { kind: "p"; lines: string[] }
  | { kind: "h"; level: 1 | 2 | 3 | 4; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "blockquote"; lines: string[] };

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trimEnd();

    if (!line.trim()) {
      i++;
      continue;
    }

    // Heading
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const rawLevel = h[1].length;
      const level = (rawLevel > 4 ? 4 : rawLevel) as 1 | 2 | 3 | 4;
      blocks.push({ kind: "h", level, text: h[2] });
      i++;
      continue;
    }

    // Unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ""));
        i++;
      }
      blocks.push({ kind: "ul", items });
      continue;
    }

    // Ordered list
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ""));
        i++;
      }
      blocks.push({ kind: "ol", items });
      continue;
    }

    // Blockquote
    if (/^\s*>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      blocks.push({ kind: "blockquote", lines: quoteLines });
      continue;
    }

    // Paragraph (consume contiguous non-blank, non-special lines)
    const paraLines: string[] = [];
    while (i < lines.length) {
      const l = lines[i];
      if (
        !l.trim() ||
        /^(#{1,6})\s+/.test(l) ||
        /^\s*[-*+]\s+/.test(l) ||
        /^\s*\d+[.)]\s+/.test(l) ||
        /^\s*>\s?/.test(l)
      ) {
        break;
      }
      paraLines.push(l);
      i++;
    }
    if (paraLines.length > 0) {
      blocks.push({ kind: "p", lines: paraLines });
    }
  }
  return blocks;
}

function renderBlocks(text: string, keyPrefix: string): React.ReactNode[] {
  const blocks = parseBlocks(text);
  return blocks.map((b, idx) => {
    const key = `${keyPrefix}-b${idx}`;
    if (b.kind === "h") {
      const Tag = (`h${b.level}` as unknown) as keyof JSX.IntrinsicElements;
      return (
        <Tag key={key} className={`md-h md-h${b.level}`}>
          {renderInline(b.text)}
        </Tag>
      );
    }
    if (b.kind === "ul") {
      return (
        <ul key={key} className="md-ul">
          {b.items.map((it, j) => (
            <li key={j}>{renderInline(it)}</li>
          ))}
        </ul>
      );
    }
    if (b.kind === "ol") {
      return (
        <ol key={key} className="md-ol">
          {b.items.map((it, j) => (
            <li key={j}>{renderInline(it)}</li>
          ))}
        </ol>
      );
    }
    if (b.kind === "blockquote") {
      return (
        <blockquote key={key} className="md-blockquote">
          {b.lines.map((l, j) => (
            <span key={j}>
              {renderInline(l)}
              {j < b.lines.length - 1 ? <br /> : null}
            </span>
          ))}
        </blockquote>
      );
    }
    // Paragraph
    return (
      <p key={key} className="md-p">
        {b.lines.map((l, j) => (
          <span key={j}>
            {renderInline(l)}
            {j < b.lines.length - 1 ? <br /> : null}
          </span>
        ))}
      </p>
    );
  });
}

export function Markdown({ text, streaming }: Props) {
  const segments = splitFencedCode(text);
  return (
    <div className="md">
      {segments.map((seg, i) =>
        seg.kind === "code" ? (
          <CodeBlock key={`cb-${i}`} lang={seg.lang} value={seg.value} />
        ) : (
          <div key={`tb-${i}`}>{renderBlocks(seg.value, `s${i}`)}</div>
        ),
      )}
      {streaming && <span className="md-caret" aria-hidden="true" />}
    </div>
  );
}
