import OpenAI from "openai";

function apiKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error("OPENAI_API_KEY is not set");
  }
  return key;
}

export function openaiClient(): OpenAI {
  return new OpenAI({ apiKey: apiKey() });
}

