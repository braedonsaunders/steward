import { createHash, timingSafeEqual } from "node:crypto";

export function hashApiToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function constantTimeEqualHex(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) {
    return false;
  }
  try {
    const left = Buffer.from(a, "hex");
    const right = Buffer.from(b, "hex");
    if (left.length !== right.length || left.length === 0) {
      return false;
    }
    return timingSafeEqual(left, right);
  } catch {
    return false;
  }
}
