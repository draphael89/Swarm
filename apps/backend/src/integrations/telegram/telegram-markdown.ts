const HTML_COMMENT_PATTERN = /<!--[\s\S]*?-->/g;
const CODE_FENCE_PATTERN = /^(\s*)(`{3,}|~{3,})(.*)$/;
const EXCESSIVE_NEWLINES_PATTERN = /\n{4,}/g;
const LINK_PATTERN = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
const INLINE_CODE_PATTERN = /`([^`\n]+)`/g;
const TOKEN_PREFIX = "\uE000TG";
const TOKEN_SUFFIX = "\uE001";

export function markdownToTelegramHtml(text: string): string {
  const preprocessed = preprocessMarkdown(text);
  const placeholders: string[] = [];
  const withCodeBlocks = convertCodeFences(preprocessed, placeholders);
  const transformed = transformInlineMarkdown(withCodeBlocks, placeholders);
  return transformed.replace(EXCESSIVE_NEWLINES_PATTERN, "\n\n").trim();
}

function preprocessMarkdown(text: string): string {
  const normalizedLineEndings = text.replace(/\r\n?/g, "\n");
  return normalizedLineEndings.replace(HTML_COMMENT_PATTERN, "");
}

function convertCodeFences(text: string, placeholders: string[]): string {
  const lines = text.split("\n");
  const outputLines: string[] = [];

  let activeFence:
    | {
        fenceToken: string;
        language?: string;
        content: string[];
      }
    | undefined;

  for (const line of lines) {
    const match = line.match(CODE_FENCE_PATTERN);

    if (!activeFence) {
      if (!match) {
        outputLines.push(line);
        continue;
      }

      const [, , rawFence, rawInfo] = match;
      activeFence = {
        fenceToken: rawFence,
        language: normalizeLanguage(rawInfo),
        content: []
      };
      continue;
    }

    if (match && match[2].startsWith(activeFence.fenceToken[0]) && match[2].length >= activeFence.fenceToken.length && match[3].trim().length === 0) {
      const codeContent = activeFence.content.join("\n");
      const escapedCode = escapeHtml(codeContent);
      const languageClass = activeFence.language ? ` class=\"language-${escapeHtmlAttribute(activeFence.language)}\"` : "";
      const token = storePlaceholder(`<pre><code${languageClass}>${escapedCode}</code></pre>`, placeholders);
      outputLines.push(token);
      activeFence = undefined;
      continue;
    }

    activeFence.content.push(line);
  }

  if (activeFence) {
    const codeContent = activeFence.content.join("\n");
    const escapedCode = escapeHtml(codeContent);
    const languageClass = activeFence.language ? ` class=\"language-${escapeHtmlAttribute(activeFence.language)}\"` : "";
    outputLines.push(storePlaceholder(`<pre><code${languageClass}>${escapedCode}</code></pre>`, placeholders));
  }

  return outputLines.join("\n");
}

function transformInlineMarkdown(text: string, placeholders: string[]): string {
  let working = text;

  working = working.replace(LINK_PATTERN, (_match, label, url) => {
    const linkLabel = applyTextDecorations(escapeHtml(String(label)));
    const escapedUrl = escapeHtmlAttribute(String(url));
    return storePlaceholder(`<a href=\"${escapedUrl}\">${linkLabel}</a>`, placeholders);
  });

  working = working.replace(INLINE_CODE_PATTERN, (_match, code) => {
    const escapedCode = escapeHtml(String(code));
    return storePlaceholder(`<code>${escapedCode}</code>`, placeholders);
  });

  const escaped = escapeHtml(working);
  const decorated = applyTextDecorations(escaped);
  return restorePlaceholders(decorated, placeholders);
}

function applyTextDecorations(text: string): string {
  let output = text;

  output = output.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");
  output = output.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  output = output.replace(/__([^_\n]+)__/g, "<b>$1</b>");
  output = output.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, "$1<i>$2</i>");
  output = output.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/g, "$1<i>$2</i>");

  return output;
}

function normalizeLanguage(info: string): string | undefined {
  const token = info.trim().split(/\s+/)[0];
  if (!token) {
    return undefined;
  }

  const cleaned = token.replace(/[^a-zA-Z0-9_-]+/g, "");
  return cleaned || undefined;
}

function storePlaceholder(value: string, placeholders: string[]): string {
  const index = placeholders.push(value) - 1;
  return `${TOKEN_PREFIX}${index}${TOKEN_SUFFIX}`;
}

function restorePlaceholders(text: string, placeholders: string[]): string {
  return text.replace(new RegExp(`${TOKEN_PREFIX}(\\d+)${TOKEN_SUFFIX}`, "g"), (_match, indexText) => {
    const index = Number.parseInt(indexText, 10);
    if (!Number.isFinite(index) || index < 0 || index >= placeholders.length) {
      return "";
    }

    return placeholders[index] ?? "";
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value).replaceAll('"', "&quot;");
}
