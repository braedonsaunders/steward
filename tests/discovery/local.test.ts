import { describe, expect, it } from "vitest";
import {
  hostsForSubnet,
  prefixLengthFromNetmask,
  sameSubnetUsingInterfaces,
  subnetCidrForIp,
  type LocalIpv4Interface,
} from "@/lib/discovery/local";

describe("subnet helpers", () => {
  it("derives the correct prefix length and cidr from a netmask", () => {
    expect(prefixLengthFromNetmask("255.255.254.0")).toBe(23);
    expect(subnetCidrForIp("10.0.5.14", "255.255.254.0")).toBe("10.0.4.0/23");
  });

  it("enumerates host addresses for a bounded subnet", () => {
    expect(hostsForSubnet("192.168.10.0/30")).toEqual(["192.168.10.1", "192.168.10.2"]);
  });

  it("checks same-subnet membership against the host interface inventory", () => {
    const interfaces: LocalIpv4Interface[] = [
      {
        name: "eth0",
        ip: "10.0.4.1",
        netmask: "255.255.254.0",
        virtual: false,
      },
    ];

    expect(sameSubnetUsingInterfaces("10.0.4.5", "10.0.5.200", interfaces)).toBe(true);
    expect(sameSubnetUsingInterfaces("10.0.4.5", "10.0.6.10", interfaces)).toBe(false);
  });

  it("falls back to a direct subnet comparison when no interface inventory is available", () => {
    expect(sameSubnetUsingInterfaces("192.168.1.10", "192.168.1.50", [])).toBe(true);
    expect(sameSubnetUsingInterfaces("192.168.1.10", "192.168.2.50", [])).toBe(false);
  });
});
