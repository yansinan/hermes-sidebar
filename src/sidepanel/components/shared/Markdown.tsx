import { memo, useMemo, useState, type ComponentType, type ReactNode } from "react";

// Markdown renderer (docs/ui-spec.md §3.2).
// Uses a maintained parser to avoid edge-case hangs from hand-rolled regex parsing.

interface Props {
  text: string;
  /** When true, renders a blinking caret after the content (streaming cue). */
  streaming?: boolean;
}

type ChildProps = { children?: ReactNode };
type LinkProps = { href?: string; children?: ReactNode };
type ImageProps = { src?: string; alt?: string };
type CodeProps = { className?: string; children?: ReactNode };

type MarkdownBundle = {
  ReactMarkdown?: ComponentType<any>;
  remarkGfm?: unknown;
};

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

type Block =
  | { kind: "p"; lines: string[] }
  | { kind: "h"; level: 1 | 2 | 3 | 4; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "blockquote"; lines: string[] }
  | {
      kind: "table";
      head: string[];
      align: Array<"left" | "center" | "right" | null>;
      rows: string[][];
    };

const MAX_RENDER_CHARS = 300_000;
const MAX_INLINE_LINE_CHARS = 40_000;
const MAX_URL_DISPLAY_CHARS = 100;

function getMarkdownBundle(): MarkdownBundle {
  return ((globalThis as any).__hermesMarkdown ?? {}) as MarkdownBundle;
}

function isTrackingImageUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return /(^|\.)bat\.bing\.com$/i.test(u.hostname) && u.pathname.startsWith("/action/");
  } catch {
    return false;
  }
}

function normalizeInput(text: string): string {
  if (text.length <= MAX_RENDER_CHARS) return text;
  return `${text.slice(0, MAX_RENDER_CHARS)}\n\n[truncated for preview]`;
}

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

function clampText(input: string, max: number): string {
  if (input.length <= max) return input;
  return `${input.slice(0, max)}...`;
}

function displayUrl(raw: string): string {
  return clampText(raw, MAX_URL_DISPLAY_CHARS);
}

function parseCodeSpan(text: string, start: number): { value: string; next: number } | null {
  if (text[start] !== "`") return null;
  const end = text.indexOf("`", start + 1);
  if (end <= start + 1) return null;
  const value = text.slice(start + 1, end);
  if (value.includes("\n")) return null;
  return { value, next: end + 1 };
}

function parseBold(text: string, start: number): { value: string; next: number } | null {
  if (!text.startsWith("**", start)) return null;
  const end = text.indexOf("**", start + 2);
  if (end <= start + 2) return null;
  const value = text.slice(start + 2, end);
  if (value.includes("\n")) return null;
  return { value, next: end + 2 };
}

function parseItalic(text: string, start: number): { value: string; next: number } | null {
  if (text[start] !== "*" || text.startsWith("**", start)) return null;
  const end = text.indexOf("*", start + 1);
  if (end <= start + 1) return null;
  const value = text.slice(start + 1, end);
  if (value.includes("\n")) return null;
  return { value, next: end + 1 };
}

function parseBracketParen(text: string, start: number): { label: string; url: string; next: number } | null {
  if (text[start] !== "[") return null;
  const closeBracket = text.indexOf("]", start + 1);
  if (closeBracket < 0 || closeBracket + 1 >= text.length || text[closeBracket + 1] !== "(") {
    return null;
  }
  const closeParen = text.indexOf(")", closeBracket + 2);
  if (closeParen < 0) return null;

  const label = text.slice(start + 1, closeBracket);
  const url = text.slice(closeBracket + 2, closeParen).trim();
  if (!/^https?:\/\//i.test(url)) return null;
  return {
    label,
    url,
    next: closeParen + 1,
  };
}

function renderInline(text: string): ReactNode[] {
  const input = clampText(text, MAX_INLINE_LINE_CHARS);
  const nodes: ReactNode[] = [];
  let i = 0;
  let keyCounter = 0;
  const push = (node: ReactNode) => nodes.push(node);

  while (i < input.length) {
    const code = parseCodeSpan(input, i);
    if (code) {
      push(
        <code key={`c-${keyCounter++}`} className="md-code-inline">
          {code.value}
        </code>,
      );
      i = code.next;
      continue;
    }

    if (input[i] === "!" && input[i + 1] === "[") {
      const image = parseBracketParen(input, i + 1);
      if (image) {
        if (!isTrackingImageUrl(image.url)) {
          push(
            <a
              key={`img-${keyCounter++}`}
              href={image.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {image.label.trim() || displayUrl(image.url)}
            </a>,
          );
        }
        i = image.next;
        continue;
      }
    }

    const link = parseBracketParen(input, i);
    if (link) {
      push(
        <a
          key={`a-${keyCounter++}`}
          href={link.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          {link.label.trim() || displayUrl(link.url)}
        </a>,
      );
      i = link.next;
      continue;
    }

    const bold = parseBold(input, i);
    if (bold) {
      push(<strong key={`b-${keyCounter++}`}>{bold.value}</strong>);
      i = bold.next;
      continue;
    }

    const italic = parseItalic(input, i);
    if (italic) {
      push(<em key={`i-${keyCounter++}`}>{italic.value}</em>);
      i = italic.next;
      continue;
    }

    let next = i + 1;
    while (next < input.length) {
      const ch = input[next];
      if (ch === "`" || ch === "[" || ch === "*" || (ch === "!" && input[next + 1] === "[")) {
        break;
      }
      next++;
    }
    push(input.slice(i, next));
    i = next;
  }

  return nodes;
}

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

    if (/^\|.+\|/.test(line) && i + 1 < lines.length && /^\|[\s|:-]+\|/.test(lines[i + 1])) {
      const parseCells = (row: string) =>
        row.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const parseAlign = (sep: string): Array<"left" | "center" | "right" | null> =>
        parseCells(sep).map((c) => {
          if (/^:-+:$/.test(c)) return "center";
          if (/^-+:$/.test(c)) return "right";
          if (/^:-+$/.test(c)) return "left";
          return null;
        });
      const head = parseCells(line);
      const align = parseAlign(lines[i + 1]);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\|.+\|/.test(lines[i])) {
        rows.push(parseCells(lines[i]));
        i++;
      }
      blocks.push({ kind: "table", head, align, rows });
      continue;
    }

    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const rawLevel = h[1].length;
      const level = (rawLevel > 4 ? 4 : rawLevel) as 1 | 2 | 3 | 4;
      blocks.push({ kind: "h", level, text: h[2] });
      i++;
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ""));
        i++;
      }
      blocks.push({ kind: "ul", items });
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ""));
        i++;
      }
      blocks.push({ kind: "ol", items });
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      blocks.push({ kind: "blockquote", lines: quoteLines });
      continue;
    }

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

function renderBlocks(text: string, keyPrefix: string): ReactNode[] {
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
    if (b.kind === "table") {
      return (
        <div key={key} className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {b.head.map((cell, j) => (
                  <th key={j} style={b.align[j] ? { textAlign: b.align[j]! } : undefined}>
                    {renderInline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, j) => (
                    <td key={j} style={b.align[j] ? { textAlign: b.align[j]! } : undefined}>
                      {renderInline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
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

function MarkdownInner({ text, streaming }: Props) {
  // 文本归一化可能处理大字符串，使用 memo 避免无关重渲染时重复计算。
  const safeText = useMemo(() => normalizeInput(text), [text]);
  const bundle = getMarkdownBundle();
  const MarkdownRenderer = bundle.ReactMarkdown;

  // ReactMarkdown 的组件映射是稳定结构，memo 后可减少对象重建与子树比对噪音。
  const components = useMemo(
    () => ({
      h1: ({ children }: ChildProps) => <h1 className="md-h md-h1">{children}</h1>,
      h2: ({ children }: ChildProps) => <h2 className="md-h md-h2">{children}</h2>,
      h3: ({ children }: ChildProps) => <h3 className="md-h md-h3">{children}</h3>,
      h4: ({ children }: ChildProps) => <h4 className="md-h md-h4">{children}</h4>,
      h5: ({ children }: ChildProps) => <h4 className="md-h md-h4">{children}</h4>,
      h6: ({ children }: ChildProps) => <h4 className="md-h md-h4">{children}</h4>,
      p: ({ children }: ChildProps) => <p className="md-p">{children}</p>,
      ul: ({ children }: ChildProps) => <ul className="md-ul">{children}</ul>,
      ol: ({ children }: ChildProps) => <ol className="md-ol">{children}</ol>,
      blockquote: ({ children }: ChildProps) => <blockquote className="md-blockquote">{children}</blockquote>,
      table: ({ children }: ChildProps) => (
        <div className="md-table-wrap">
          <table className="md-table">{children}</table>
        </div>
      ),
      a: ({ href, children }: LinkProps) => (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      ),
      img: ({ src, alt }: ImageProps) => {
        const safeSrc = src ?? "";
        if (!safeSrc || isTrackingImageUrl(safeSrc)) return null;
        return (
          <a href={safeSrc} target="_blank" rel="noopener noreferrer">
            {alt?.trim() || "image"}
          </a>
        );
      },
      code: ({ className, children }: CodeProps) => {
        const raw = String(children ?? "");
        const value = raw.replace(/\n$/, "");
        const match = /language-([^\s]+)/.exec(className ?? "");
        if (!match) {
          return <code className="md-code-inline">{children}</code>;
        }
        return <CodeBlock lang={match[1]} value={value} />;
      },
    }),
    [],
  );

  // fallback 渲染路径中，分段解析是主要开销点，safeText 不变则复用结果。
  const fallbackSegments = useMemo(() => splitFencedCode(safeText), [safeText]);

  if (!MarkdownRenderer) {
    return (
      <div className="md">
        {fallbackSegments.map((seg, i) =>
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

  return (
    <div className="md">
      <MarkdownRenderer
        remarkPlugins={bundle.remarkGfm ? [bundle.remarkGfm] : []}
        components={components as any}
      >
        {safeText}
      </MarkdownRenderer>
      {streaming && <span className="md-caret" aria-hidden="true" />}
    </div>
  );
}

// 共享渲染器：当 text/streaming 未变化时跳过重渲染，减少消息区与预览区的重复计算。
export const Markdown = memo(MarkdownInner);
