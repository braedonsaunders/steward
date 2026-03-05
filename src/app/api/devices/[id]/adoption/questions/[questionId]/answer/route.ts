import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { finalizeAdoptionRunIfReady, getDeviceAdoptionSnapshot } from "@/lib/adoption/orchestrator";
import { stateStore } from "@/lib/state/store";

export const runtime = "nodejs";

const answerSchema = z.object({
  answer: z.record(z.string(), z.unknown()),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; questionId: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, questionId } = await params;
  const payload = answerSchema.safeParse(await request.json().catch(() => ({})));
  if (!payload.success) {
    return NextResponse.json({ error: payload.error.flatten() }, { status: 400 });
  }

  const questionList = stateStore.getAdoptionQuestions(id, { unresolvedOnly: false });
  const question = questionList.find((item) => item.id === questionId);
  if (!question) {
    return NextResponse.json({ error: "Question not found" }, { status: 404 });
  }

  const updated = stateStore.answerAdoptionQuestion(questionId, payload.data.answer);
  if (!updated) {
    return NextResponse.json({ error: "Question not found" }, { status: 404 });
  }

  await stateStore.addAction({
    actor: "user",
    kind: "config",
    message: `Answered onboarding question for device ${id}`,
    context: {
      deviceId: id,
      questionId,
      questionKey: question.questionKey,
    },
  });

  await finalizeAdoptionRunIfReady(id);
  const snapshot = await getDeviceAdoptionSnapshot(id);
  return NextResponse.json({ question: updated, snapshot });
}
