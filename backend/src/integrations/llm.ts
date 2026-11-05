import { env, llmConfigured } from '../config/env.js';
import { logger } from '../config/logger.js';

/**
 * The language model client.
 *
 * Two providers are supported behind one interface: Google Gemini, which is the
 * default because its free tier is enough to run this assignment, and any
 * OpenAI-compatible endpoint, which covers Groq, OpenRouter and the rest. The
 * application only ever asks for a JSON object back, so the parsing and the
 * failure handling live here rather than in the agent.
 *
 * Nothing in the application depends on the model being available. If the key
 * is missing or the call fails, the caller is told so and falls back to rules,
 * which route the reply to a person instead of answering it.
 */

export interface LlmResult<T> {
  ok: boolean;
  data: T | null;
  raw: string;
  error: string | null;
}

export interface LlmClient {
  readonly available: boolean;
  readonly model: string;
  completeJson<T>(prompt: { system: string; user: string }): Promise<LlmResult<T>>;
}

const TIMEOUT_MS = 30_000;
const MAX_OUTPUT_TOKENS = 1200;

/** Models like to wrap JSON in prose or a code fence. Pull the object out. */
export function extractJsonObject(text: string): unknown | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? text).trim();

  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;

  try {
    return JSON.parse(candidate.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

async function postJson(url: string, body: unknown, headers: Record<string, string>): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

class GeminiClient implements LlmClient {
  readonly available = true;
  readonly model = env.LLM_MODEL;

  async completeJson<T>(prompt: { system: string; user: string }): Promise<LlmResult<T>> {
    const base = env.LLM_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';
    const url = `${base}/models/${encodeURIComponent(this.model)}:generateContent`;
    try {
      const response = await postJson(
        url,
        {
          systemInstruction: { parts: [{ text: prompt.system }] },
          contents: [{ role: 'user', parts: [{ text: prompt.user }] }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: MAX_OUTPUT_TOKENS,
            responseMimeType: 'application/json',
          },
        },
        { 'x-goog-api-key': env.LLM_API_KEY },
      );

      if (!response.ok) {
        const detail = await response.text();
        return { ok: false, data: null, raw: '', error: `Gemini returned ${response.status}: ${detail.slice(0, 300)}` };
      }

      const payload = (await response.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const raw = payload.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
      const parsed = extractJsonObject(raw);
      return parsed
        ? { ok: true, data: parsed as T, raw, error: null }
        : { ok: false, data: null, raw, error: 'The model did not return usable JSON.' };
    } catch (error) {
      return { ok: false, data: null, raw: '', error: (error as Error).message };
    }
  }
}

class OpenAiCompatibleClient implements LlmClient {
  readonly available = true;
  readonly model = env.LLM_MODEL;

  async completeJson<T>(prompt: { system: string; user: string }): Promise<LlmResult<T>> {
    const base = env.LLM_BASE_URL || 'https://api.openai.com/v1';
    try {
      const response = await postJson(
        `${base}/chat/completions`,
        {
          model: this.model,
          temperature: 0.2,
          max_tokens: MAX_OUTPUT_TOKENS,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ],
        },
        { authorization: `Bearer ${env.LLM_API_KEY}` },
      );

      if (!response.ok) {
        const detail = await response.text();
        return {
          ok: false,
          data: null,
          raw: '',
          error: `The provider returned ${response.status}: ${detail.slice(0, 300)}`,
        };
      }

      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const raw = payload.choices?.[0]?.message?.content ?? '';
      const parsed = extractJsonObject(raw);
      return parsed
        ? { ok: true, data: parsed as T, raw, error: null }
        : { ok: false, data: null, raw, error: 'The model did not return usable JSON.' };
    } catch (error) {
      return { ok: false, data: null, raw: '', error: (error as Error).message };
    }
  }
}

class UnavailableClient implements LlmClient {
  readonly available = false;
  readonly model = 'none';
  async completeJson<T>(): Promise<LlmResult<T>> {
    return {
      ok: false,
      data: null,
      raw: '',
      error: 'No LLM is configured. Set LLM_API_KEY, or LLM_ENABLED=false to silence this.',
    };
  }
}

let client: LlmClient | null = null;

export function getLlmClient(): LlmClient {
  if (client) return client;
  if (!llmConfigured) {
    logger.warn('No LLM key configured; replies will be classified by rules and sent for review');
    client = new UnavailableClient();
  } else if (env.LLM_PROVIDER === 'gemini') {
    client = new GeminiClient();
  } else {
    client = new OpenAiCompatibleClient();
  }
  return client;
}

/** Used by the tests to supply a deterministic model. */
export function setLlmClient(replacement: LlmClient | null): void {
  client = replacement;
}
