"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useParams } from "next/navigation";
import { ArrowLeft, Server, Wrench } from "lucide-react";
import { DeviceWorkloadsPanel } from "@/components/device-workloads-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useSteward } from "@/lib/hooks/use-steward";

export default function DeviceOnboardingPage() {
  const params = useParams<{ id: string }>();
  const deviceId = params.id;
  const { devices, loading, error } = useSteward();
  const device = useMemo(
    () => devices.find((item) => item.id === deviceId),
    [devices, deviceId],
  );

  if (loading) {
    return (
      <main className="flex h-full min-h-0 flex-col gap-4">
        <Skeleton className="h-5 w-36" />
        <Skeleton className="h-12 w-72" />
        <Skeleton className="min-h-0 flex-1" />
      </main>
    );
  }

  if (error) {
    return (
      <main className="flex h-full min-h-0 flex-col gap-4">
        <Card className="border-destructive">
          <CardHeader>
            <CardTitle className="text-destructive">Error</CardTitle>
            <CardDescription>{error}</CardDescription>
          </CardHeader>
        </Card>
      </main>
    );
  }

  if (!device) {
    return (
      <main className="flex h-full min-h-0 flex-col gap-4">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/devices">
            <ArrowLeft className="mr-2 size-4" />
            Back to Devices
          </Link>
        </Button>
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <Server className="size-10 text-muted-foreground/50" />
            <div className="space-y-1">
              <p className="text-sm font-medium text-muted-foreground">
                Device not found
              </p>
              <p className="text-xs text-muted-foreground/70">
                The selected device no longer exists.
              </p>
            </div>
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <main className="flex h-full min-h-0 flex-col gap-4">
      <Button variant="ghost" size="sm" asChild>
        <Link href={`/devices/${deviceId}`}>
          <ArrowLeft className="mr-2 size-4" />
          Back to Device Overview
        </Link>
      </Button>

      <section className="rounded-lg border bg-card/65 p-4">
        <div className="flex items-center gap-2">
          <Wrench className="size-4 text-muted-foreground" />
          <h1 className="text-xl font-semibold tracking-tight steward-heading-font">
            Responsibilities & Onboarding
          </h1>
          <Badge variant="outline" className="ml-auto">
            {device.name}
          </Badge>
        </div>
      </section>

      <div className="min-h-0 flex-1 overflow-hidden">
        <DeviceWorkloadsPanel deviceId={deviceId} className="h-full" />
      </div>
    </main>
  );
}
