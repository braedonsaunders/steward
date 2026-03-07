import { NextResponse, type NextRequest } from "next/server";
import { isAuthorized } from "@/lib/auth/guard";
import { localToolExecuteSchema } from "@/lib/local-tools/schema";
import { localToolRuntime } from "@/lib/local-tools/runtime";

export const runtime = "nodejs";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const parsed = localToolExecuteSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const result = await localToolRuntime.execute({
    toolId: id,
    ...parsed.data,
  }, "user");

  if ("status" in result && result.status !== undefined) {
    return NextResponse.json(result, { status: result.ok ? 200 : result.status === "blocked" ? 202 : 400 });
  }

  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
