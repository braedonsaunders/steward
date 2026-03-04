export const runtime = "nodejs";

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { stateStore } from "@/lib/state/store";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  actor: z.enum(["steward", "user"]).optional(),
  kind: z.enum([
    "discover",
    "diagnose",
    "remediate",
    "learn",
    "config",
    "auth",
    "policy",
    "playbook",
    "approval",
    "digest",
  ]).optional(),
  since: z.string().datetime({ offset: true }).optional(),
  until: z.string().datetime({ offset: true }).optional(),
  cursor: z.string().optional(),
  format: z.enum(["json", "jsonl"]).optional(),
});

type Cursor = { at: string; id: string };

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(raw: string): Cursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as {
      at?: unknown;
      id?: unknown;
    };

    if (typeof parsed.at !== "string" || typeof parsed.id !== "string") {
      return null;
    }

    return { at: parsed.at, id: parsed.id };
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = querySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams.entries()),
  );
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const query = parsed.data;
  const decodedCursor = query.cursor ? decodeCursor(query.cursor) : null;
  if (query.cursor && !decodedCursor) {
    return NextResponse.json({ error: "Invalid cursor" }, { status: 400 });
  }

  const page = stateStore.getAuditEventsPage({
    limit: query.limit,
    actor: query.actor,
    kind: query.kind,
    sinceAt: query.since,
    untilAt: query.until,
    cursor: decodedCursor ?? undefined,
  });

  const nextCursor = page.nextCursor ? encodeCursor(page.nextCursor) : null;
  if (query.format === "jsonl") {
    const body = page.events.map((event) => JSON.stringify(event)).join("\n");
    const response = new NextResponse(body, {
      status: 200,
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
      },
    });

    if (nextCursor) {
      response.headers.set("x-next-cursor", nextCursor);
    }

    return response;
  }

  return NextResponse.json({
    events: page.events,
    nextCursor,
    limit: query.limit ?? 100,
  });
}
