export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  const { ensureStewardLoop } = await import("./lib/agent/loop");
  ensureStewardLoop();
}
