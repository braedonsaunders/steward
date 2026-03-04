import { NextResponse, type NextRequest } from "next/server";
import { isAuthorized } from "@/lib/auth/guard";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json(
    {
      error:
        "OpenAI OAuth is not supported for API provider authentication. Use an OpenAI Platform API key (OPENAI_API_KEY) in Settings.",
      code: "OPENAI_OAUTH_UNSUPPORTED",
    },
    { status: 400 },
  );
}
