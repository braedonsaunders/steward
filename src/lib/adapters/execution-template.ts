export function interpolateOperationValue(
  template: string,
  host: string,
  params: Record<string, string>,
): string {
  let result = template;
  result = result.replace(/\{\{host\}\}/g, host);
  for (const [key, value] of Object.entries(params)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
  }
  return result;
}
