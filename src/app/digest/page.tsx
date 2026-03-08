"use client";

import { useState } from "react";
import {
  FileText,
  Loader2,
  RefreshCw,
  Sunrise,
} from "lucide-react";
import { useSteward } from "@/lib/hooks/use-steward";
import { DigestView } from "@/components/digest-view";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function DigestPage() {
  const { latestDigest, loading, generateDigest } = useSteward();
  const [generating, setGenerating] = useState(false);

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      await generateDigest();
    } finally {
      setGenerating(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-6">
        <div className="flex items-center justify-between">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-9 w-36" />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-20" />
              ))}
            </div>
            <Skeleton className="h-64" />
            <Skeleton className="h-48" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Sunrise className="h-6 w-6 text-muted-foreground" />
          <h1 className="text-2xl font-semibold tracking-tight steward-heading-font">
            Daily Digest
          </h1>
          {latestDigest && (
            <Badge variant="outline" className="text-xs">
              {new Date(latestDigest.generatedAt).toLocaleDateString(
                undefined,
                {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                },
              )}
            </Badge>
          )}
        </div>
        <Button
          size="sm"
          onClick={handleGenerate}
          disabled={generating}
        >
          {generating ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          )}
          {generating ? "Generating..." : "Generate Now"}
        </Button>
      </div>

      {/* Content */}
      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {latestDigest ? (
          <DigestView digest={latestDigest} />
        ) : (
          <Card>
            <CardContent className="flex flex-col items-center justify-center gap-4 py-20">
              <FileText className="h-12 w-12 text-muted-foreground/40" />
              <div className="text-center space-y-1">
                <p className="text-sm font-medium text-muted-foreground">
                  No digest generated yet
                </p>
                <p className="text-xs text-muted-foreground/70">
                  Click &quot;Generate Now&quot; to create your first daily digest
                  summarizing overnight activity, incidents, and recommendations.
                </p>
              </div>
              <Button
                variant="outline"
                onClick={handleGenerate}
                disabled={generating}
              >
                {generating ? (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="mr-1.5 h-4 w-4" />
                )}
                Generate First Digest
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
