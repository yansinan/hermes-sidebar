import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

(function attachMarkdownBundle() {
  const g = globalThis;
  g.__hermesMarkdown = {
    ReactMarkdown,
    remarkGfm,
  };
})();
