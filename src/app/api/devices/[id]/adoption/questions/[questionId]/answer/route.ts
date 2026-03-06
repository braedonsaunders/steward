import { NextResponse, type NextRequest } from "next/server";
import { isAuthorized } from "@/lib/auth/guard";

export const runtime = "nodejs";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; questionId: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  return NextResponse.json(
    {
      error: "Legacy onboarding questions are retired. Use conversational onboarding in the Workloads tab.",
      deviceId: id,
    },
    { status: 410 },
  );
}
