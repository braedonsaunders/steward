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
    const client = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = client(url, {
      method: options.method,
      headers: options.headers ?? {},
      ...(url.protocol === "https:" && options.insecureSkipVerify
        ? { agent: new HttpsAgent({ rejectUnauthorized: false }) }
        : {}),
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        const statusCode = res.statusCode ?? 0;
        resolve({
          ok: statusCode >= 200 && statusCode < 400,
          statusCode,
          body: body.trim(),
          headers: res.headers,
        });
      });
    });

    req.setTimeout(options.timeoutMs, () => {
      req.destroy(new Error("Request timed out"));
    });
    req.on("error", (error) => {
      resolve({
        ok: false,
        statusCode: 0,
        body: "",
        headers: {},
        error: error instanceof Error ? error.message : String(error),
      });
    });

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}
