import { NextResponse, type NextRequest } from "next/server";
import { isAuthorized } from "@/lib/auth/guard";
import { redactDeviceCredential, validateDeviceCredential } from "@/lib/adoption/credentials";

export const runtime = "nodejs";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; credentialId: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, credentialId } = await params;

  try {
    const credential = await validateDeviceCredential(id, credentialId);
    return NextResponse.json({ credential: redactDeviceCredential(credential) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to validate credential" },
      { status: 400 },
    );
  }
}
