import { slackifyMarkdown } from "slackify-markdown";

const HTML_COMMENT_PATTERN = /<!--[\s\S]*?-->/g;
const CODE_FENCE_PATTERN = /^(\s*)(`{3,}|~{3,})(.*)$/;
const EXCESSIVE_NEWLINES_PATTERN = /\n{4,}/g;

export function markdownToSlackMrkdwn(text: string): string {
  const preprocessed = preprocessMarkdown(text);
  const slackified = slackifyMarkdown(preprocessed);
  return postprocessSlackMrkdwn(slackified);
}

function preprocessMarkdown(text: string): string {
  const normalizedLineEndings = text.replace(/\r\n?/g, "\n");
  const withoutHtmlComments = normalizedLineEndings.replace(HTML_COMMENT_PATTERN, "");
  return normalizeCodeFences(withoutHtmlComments);
}

function normalizeCodeFences(text: string): string {
  const lines = text.split("\n");
  const normalizedLines: string[] = [];
  let activeFenceLength: number | null = null;

  for (const line of lines) {
    const match = line.match(CODE_FENCE_PATTERN);
    if (!match) {
      normalizedLines.push(line);
      continue;
    }

    const [, indent, rawFence, rawRemainder] = match;
    const fenceLength = Math.max(3, rawFence.length);

    if (activeFenceLength === null) {
      const info = rawRemainder.trim();
      normalizedLines.push(`${indent}${"`".repeat(fenceLength)}${info}`);
      activeFenceLength = fenceLength;
      continue;
    }

    if (rawRemainder.trim().length === 0 && rawFence.length >= activeFenceLength) {
      normalizedLines.push(`${indent}${"`".repeat(activeFenceLength)}`);
      activeFenceLength = null;
      continue;
    }

    normalizedLines.push(line);
  }

  if (activeFenceLength !== null) {
    normalizedLines.push("`".repeat(activeFenceLength));
  }

  return normalizedLines.join("\n");
}

function postprocessSlackMrkdwn(text: string): string {
  return text.replace(EXCESSIVE_NEWLINES_PATTERN, "\n\n").trim();
}
