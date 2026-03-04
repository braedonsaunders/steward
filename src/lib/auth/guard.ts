import type { NextRequest } from "next/server";

export const isAuthorized = (request: NextRequest): boolean => {
  const requiredToken = process.env.STEWARD_UI_TOKEN;

  if (!requiredToken) {
    return true;
  }

  const bearer = request.headers.get("authorization") ?? "";
  const custom = request.headers.get("x-steward-token") ?? "";

  if (custom && custom === requiredToken) {
    return true;
  }

  if (bearer.startsWith("Bearer ") && bearer.replace("Bearer ", "") === requiredToken) {
    return true;
  }

  return false;
};
