import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { isAuthorized } from "@/lib/auth/guard";
import { getDataDir } from "@/lib/state/db";

const CHAT_ARTIFACTS_ROOT = path.resolve(getDataDir(), "artifacts", "browser-browse");

function inferContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "application/octet-stream";
}

function normalizeRelativeArtifactPath(value: string): string | null {
  const normalized = value.replace(/\\/g, "/").trim();
  if (!normalized) {
    return null;
  }
  if (normalized.includes("..") || normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    return null;
  }
  if (!normalized.startsWith("artifacts/browser-browse/")) {
    return null;
  }
  return normalized;
}

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rawPath = request.nextUrl.searchParams.get("path") ?? "";
  const relativePath = normalizeRelativeArtifactPath(rawPath);
  if (!relativePath) {
    return NextResponse.json({ error: "Invalid artifact path." }, { status: 400 });
  }

  const absolutePath = path.resolve(getDataDir(), ...relativePath.split("/"));
  if (!absolutePath.startsWith(`${CHAT_ARTIFACTS_ROOT}${path.sep}`)) {
    return NextResponse.json({ error: "Artifact path rejected." }, { status: 403 });
  }

  try {
    const content = await readFile(absolutePath);
    return new NextResponse(content, {
      status: 200,
      headers: {
        "content-type": inferContentType(absolutePath),
        "cache-control": "private, max-age=3600",
      },
    });
  } catch {
    return NextResponse.json({ error: "Artifact not found." }, { status: 404 });
  }
}
