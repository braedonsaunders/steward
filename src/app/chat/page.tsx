"use client";

import { Suspense } from "react";
import { ChatWorkspace } from "@/components/chat-workspace";

export default function ChatPage() {
  return (
    <Suspense fallback={<div className="h-full min-h-[280px] animate-pulse rounded-lg border bg-muted/30" />}>
      <ChatWorkspace />
    </Suspense>
  );
}
