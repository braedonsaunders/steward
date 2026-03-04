export const runtime = "nodejs";

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isAuthorized } from "@/lib/auth/guard";
import { stateStore } from "@/lib/state/store";
import { generateDigest } from "@/lib/digest/generator";

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const digest = stateStore.getLatestDigest();
  if (!digest) {
    return NextResponse.json({ error: "No digest generated yet" }, { status: 404 });
  }

  return NextResponse.json(digest);
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const digest = await generateDigest();
  return NextResponse.json(digest, { status: 201 });
}
