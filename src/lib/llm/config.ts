import { stateStore } from "@/lib/state/store";
import type { LLMProvider, ProviderConfig } from "@/lib/state/types";

export const listProviderConfigs = async (): Promise<ProviderConfig[]> => {
  const state = await stateStore.getState();
  return state.providerConfigs;
};

export const getProviderConfig = async (
  provider: LLMProvider,
): Promise<ProviderConfig | undefined> => {
  const state = await stateStore.getState();
  return state.providerConfigs.find((item) => item.provider === provider);
};

export const getDefaultProvider = async (): Promise<LLMProvider> => {
  const state = await stateStore.getState();
  const enabled = state.providerConfigs.find((item) => item.enabled);
  return enabled?.provider ?? "openai";
};
