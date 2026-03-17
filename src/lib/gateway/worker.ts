export {
  enqueueApprovalFollowupJob,
  enqueueGatewayDeliveryJob,
} from "@/lib/autonomy/runtime";

import { autonomyStore } from "@/lib/autonomy/store";

export async function pollGatewayBindings(): Promise<void> {
  const bindings = autonomyStore.listGatewayBindings().filter((binding) => {
    const transportMode = typeof binding.configJson.transportMode === "string"
      ? binding.configJson.transportMode
      : binding.configJson.webhookUrl
        ? "webhook"
        : "polling";
    return binding.enabled && binding.kind === "telegram" && transportMode === "polling";
  });

  const { pollTelegramBinding } = await import("@/lib/autonomy/gateway");
  for (const binding of bindings) {
    await pollTelegramBinding(binding.id);
  }
}
