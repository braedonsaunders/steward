const INVALID_DEVICE_NAME_TOKENS = new Set([
  "this",
  "that",
  "it",
  "device",
  "host",
  "box",
  "machine",
  "appliance",
  "thing",
]);

export function normalizeDeviceName(value: string): string {
  return value.trim().replace(/\s+/g, " ").replace(/[.?!,;:]+$/, "");
}

export function getDeviceNameValidationError(value: string): string | null {
  const normalized = normalizeDeviceName(value);
  if (normalized.length < 2 || normalized.length > 128) {
    return "Device names must be between 2 and 128 characters.";
  }

  const lowered = normalized.toLowerCase();
  if (INVALID_DEVICE_NAME_TOKENS.has(lowered) || /^(?:this|that|it)(?:\s+device)?$/i.test(lowered)) {
    return "Provide a specific device name, not a placeholder like 'this' or 'it'.";
  }

  if (/^(?:this|that|it)\s+device\b/i.test(normalized)) {
    return "That looks like an instruction reference, not a device name.";
  }

  if (/\bits\s+category\b/i.test(normalized)) {
    return "That looks like a category-change instruction, not a device name.";
  }

  if (/\b(?:and|then)\s+(?:change|set|update|mark)\b/i.test(normalized)) {
    return "That looks like a follow-up instruction, not a device name.";
  }

  if (/\b(?:change|set|update|mark)\s+(?:its|the)\s+category\b/i.test(normalized)) {
    return "That looks like a category-change instruction, not a device name.";
  }

  return null;
}

export function isValidDeviceName(value: string): boolean {
  return getDeviceNameValidationError(value) === null;
}
