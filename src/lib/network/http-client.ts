import { request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";

export interface HttpTextRequestOptions {
  method: string;
  headers?: Record<string, string>;
  insecureSkipVerify?: boolean;
  body?: string;
  timeoutMs: number;
}

export interface HttpTextResponse {
  ok: boolean;
  statusCode: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
  error?: string;
}

export function requestText(
  url: URL,
  options: HttpTextRequestOptions,
): Promise<HttpTextResponse> {
  return new Promise((resolve) => {
    let settled = false;
    let statusCode = 0;
    let headers: Record<string, string | string[] | undefined> = {};
    let body = "";
    let responseStarted = false;
    let responseEnded = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined = undefined;
    const settle = (result: HttpTextResponse) => {
      if (settled) {
        return;
      }
      settled = true;
      if (deadlineTimer) {
        clearTimeout(deadlineTimer);
      }
      resolve(result);
    };
    const client = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = client(url, {
      method: options.method,
      headers: options.headers ?? {},
      ...(url.protocol === "https:" && options.insecureSkipVerify
        ? { agent: new HttpsAgent({ rejectUnauthorized: false }) }
        : {}),
    }, (res) => {
      responseStarted = true;
      statusCode = res.statusCode ?? 0;
      headers = res.headers;
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        responseEnded = true;
        settle({
          ok: statusCode >= 200 && statusCode < 400,
          statusCode,
          body: body.trim(),
          headers,
        });
      });
      res.on("aborted", () => {
        settle({
          ok: false,
          statusCode,
          body: body.trim(),
          headers,
          error: "Response aborted before completion.",
        });
      });
      res.on("close", () => {
        if (responseEnded) {
          return;
        }
        settle({
          ok: false,
          statusCode,
          body: body.trim(),
          headers,
          error: "Response closed before completion.",
        });
      });
    });

    deadlineTimer = setTimeout(() => {
      req.destroy(new Error("Request timed out"));
      settle({
        ok: false,
        statusCode,
        body: body.trim(),
        headers,
        error: responseStarted
          ? `Request exceeded ${options.timeoutMs}ms before the response completed.`
          : `Request timed out after ${options.timeoutMs}ms.`,
      });
    }, options.timeoutMs);
    req.setTimeout(options.timeoutMs, () => {
      req.destroy(new Error("Request timed out"));
    });
    req.on("error", (error) => {
      settle({
        ok: false,
        statusCode,
        body: body.trim(),
        headers,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}
