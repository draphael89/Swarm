#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { GoogleGenAI } from "@google/genai";
import mime from "mime";

const MODEL = "gemini-3-pro-image-preview";
const DEFAULT_IMAGE_SIZE = "1K";
const REQUIRED_MODALITIES = ["IMAGE", "TEXT"];
const SUPPORTED_FLAGS = new Set(["prompt", "output", "aspect-ratio", "size"]);

function printJson(payload) {
  console.log(`${JSON.stringify(payload, null, 2)}\n`);
}

function parseArgs(argv) {
  const flags = new Map();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }

    const key = token.slice(2);
    if (!SUPPORTED_FLAGS.has(key)) {
      throw new Error(`Unknown flag: --${key}`);
    }

    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }

    flags.set(key, value);
    index += 1;
  }

  return flags;
}

function getRequiredFlag(flags, name) {
  const value = flags.get(name);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing required flag --${name}`);
  }
  return value.trim();
}

function getOptionalFlag(flags, name) {
  const value = flags.get(name);
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveOutputPath(rawPath, mimeType) {
  const absoluteOutputPath = resolve(rawPath);
  if (extname(absoluteOutputPath).length > 0) {
    return absoluteOutputPath;
  }

  const extension = mime.getExtension(mimeType);
  if (!extension) {
    return absoluteOutputPath;
  }

  return `${absoluteOutputPath}.${extension}`;
}

function extractInlineData(part) {
  if (!part || typeof part !== "object") {
    return undefined;
  }

  const inlineData = part.inlineData;
  if (!inlineData || typeof inlineData !== "object") {
    return undefined;
  }

  const data = typeof inlineData.data === "string" ? inlineData.data.trim() : "";
  if (!data) {
    return undefined;
  }

  const mimeType =
    typeof inlineData.mimeType === "string" && inlineData.mimeType.trim().length > 0
      ? inlineData.mimeType.trim()
      : "image/png";

  return { data, mimeType };
}

async function findFirstImageInlineData(stream) {
  for await (const chunk of stream) {
    const candidates = Array.isArray(chunk?.candidates) ? chunk.candidates : [];
    for (const candidate of candidates) {
      const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
      for (const part of parts) {
        const inlineData = extractInlineData(part);
        if (inlineData) {
          return inlineData;
        }
      }
    }
  }

  return undefined;
}

async function main() {
  try {
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY environment variable is required.");
    }

    const flags = parseArgs(process.argv.slice(2));
    const prompt = getRequiredFlag(flags, "prompt");
    const output = getRequiredFlag(flags, "output");
    const aspectRatio = getOptionalFlag(flags, "aspect-ratio");
    const size = getOptionalFlag(flags, "size") ?? DEFAULT_IMAGE_SIZE;

    const ai = new GoogleGenAI({ apiKey });

    const imageConfig = {
      imageSize: size
    };

    if (aspectRatio) {
      imageConfig.aspectRatio = aspectRatio;
    }

    const stream = await ai.models.generateContentStream({
      model: MODEL,
      config: {
        imageConfig,
        responseModalities: REQUIRED_MODALITIES
      },
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }]
        }
      ]
    });

    const imageInlineData = await findFirstImageInlineData(stream);
    if (!imageInlineData) {
      throw new Error("No image data found in Gemini response.");
    }

    const outputPath = resolveOutputPath(output, imageInlineData.mimeType);
    const imageBuffer = Buffer.from(imageInlineData.data, "base64");

    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, imageBuffer);

    printJson({
      ok: true,
      file: outputPath,
      mimeType: imageInlineData.mimeType
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    printJson({
      ok: false,
      error: message
    });
    process.exitCode = 1;
  }
}

await main();
