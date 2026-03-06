import type { HttpBrokerRequest, OperationSpec } from "@/lib/state/types";

export function sshBrokerRequest(...argv: string[]): NonNullable<OperationSpec["brokerRequest"]> {
  return {
    protocol: "ssh",
    argv,
  };
}

export function sshShellBrokerRequest(command: string): NonNullable<OperationSpec["brokerRequest"]> {
  return sshBrokerRequest("sh", "-lc", command);
}

export function httpBrokerRequest(
  request: Omit<HttpBrokerRequest, "protocol">,
): NonNullable<OperationSpec["brokerRequest"]> {
  return {
    protocol: "http",
    ...request,
  };
}
