import { SourceError, errorMessage } from "../errors.js";

export interface JsonResponse {
  status: number;
  data: unknown;
  headers: Headers;
}

export interface RequestOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
  retries?: number;
  retryDelayMs?: number;
}

function parseRetryAfter(headers: Headers): number | null {
  const value = headers.get("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 15_000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 0), 15_000);
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function requestJson(url: string, options: RequestOptions): Promise<JsonResponse> {
  const retries = options.retries ?? 1;
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: options.method ?? "GET",
        headers: options.headers,
        body: options.body,
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      const text = await response.text();
      if (!response.ok) {
        if ((response.status === 429 || response.status >= 500) && attempt < retries) {
          const retryAfter = parseRetryAfter(response.headers);
          await sleep(retryAfter ?? (options.retryDelayMs ?? 500) * (attempt + 1));
          continue;
        }
        let upstreamMessage = "";
        try {
          const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
          upstreamMessage =
            typeof parsed.error === "string"
              ? parsed.error
              : typeof parsed.message === "string"
                ? parsed.message
                : "";
        } catch {
          upstreamMessage = "";
        }
        throw new SourceError(
          `http_${response.status}`,
          upstreamMessage
            ? `Source returned HTTP ${response.status}: ${upstreamMessage.slice(0, 300)}`
            : `Source returned HTTP ${response.status}`,
          {
            retryable: response.status === 429 || response.status >= 500,
            statusCode: response.status,
          },
        );
      }
      let data: unknown;
      try {
        data = JSON.parse(text) as unknown;
      } catch {
        throw new SourceError("invalid_json", "Source returned an invalid JSON response");
      }
      return { status: response.status, data, headers: response.headers };
    } catch (error) {
      lastError = error;
      if (error instanceof SourceError && !error.retryable) throw error;
      if (attempt >= retries) break;
      await sleep((options.retryDelayMs ?? 500) * (attempt + 1));
    }
  }

  if (lastError instanceof SourceError) throw lastError;
  if (lastError instanceof Error && lastError.name === "TimeoutError") {
    throw new SourceError("timeout", "The source request timed out. Try a smaller search area.", {
      retryable: true,
    });
  }
  throw new SourceError("network_error", `Could not reach the source: ${errorMessage(lastError)}`, {
    retryable: true,
  });
}
