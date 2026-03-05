import dgram from "node:dgram";
import http from "node:http";
import type { DiscoveryCandidate } from "@/lib/discovery/types";
import { buildObservation } from "@/lib/discovery/evidence";
import type { DeviceType } from "@/lib/state/types";

/* ---------- mDNS (Bonjour / DNS-SD) ---------- */

const MDNS_ADDR = "224.0.0.251";
const MDNS_PORT = 5353;

// mDNS service type to device type mapping
const MDNS_SERVICE_TYPE_MAP: Record<string, { type: DeviceType; label: string }> = {
  "_airplay._tcp": { type: "iot", label: "AirPlay" },
  "_raop._tcp": { type: "iot", label: "AirPlay Audio" },
  "_googlecast._tcp": { type: "iot", label: "Chromecast" },
  "_spotify-connect._tcp": { type: "iot", label: "Spotify Connect" },
  "_sonos._tcp": { type: "iot", label: "Sonos" },
  "_ipp._tcp": { type: "printer", label: "IPP Printer" },
  "_ipps._tcp": { type: "printer", label: "IPP Printer (Secure)" },
  "_printer._tcp": { type: "printer", label: "Printer" },
  "_pdl-datastream._tcp": { type: "printer", label: "PDL Printer" },
  "_scanner._tcp": { type: "printer", label: "Scanner" },
  "_http._tcp": { type: "server", label: "Web Server" },
  "_https._tcp": { type: "server", label: "Web Server (Secure)" },
  "_smb._tcp": { type: "server", label: "SMB File Share" },
  "_afpovertcp._tcp": { type: "server", label: "AFP File Share" },
  "_nfs._tcp": { type: "server", label: "NFS" },
  "_ssh._tcp": { type: "server", label: "SSH" },
  "_sftp-ssh._tcp": { type: "server", label: "SFTP" },
  "_homekit._tcp": { type: "iot", label: "HomeKit" },
  "_hap._tcp": { type: "iot", label: "HomeKit Accessory" },
  "_hue._tcp": { type: "iot", label: "Philips Hue" },
  "_mqtt._tcp": { type: "iot", label: "MQTT" },
  "_coap._udp": { type: "iot", label: "CoAP" },
  "_companion-link._tcp": { type: "workstation", label: "Apple Companion" },
  "_sleep-proxy._udp": { type: "iot", label: "Sleep Proxy" },
  "_rtsp._tcp": { type: "camera", label: "RTSP Camera" },
  "_daap._tcp": { type: "iot", label: "DAAP Media" },
  "_workstation._tcp": { type: "workstation", label: "Workstation" },
  "_device-info._tcp": { type: "unknown", label: "Device Info" },
  "_rdlink._tcp": { type: "workstation", label: "Remote Desktop" },
};

// Per-service type-hint confidence. File-sharing announcements are common on user endpoints,
// so they stay weak hints unless paired with stronger infrastructure indicators.
const MDNS_TYPE_HINT_WEIGHT: Record<string, number> = {
  "_airplay._tcp": 60,
  "_raop._tcp": 55,
  "_googlecast._tcp": 62,
  "_spotify-connect._tcp": 58,
  "_sonos._tcp": 65,
  "_ipp._tcp": 72,
  "_ipps._tcp": 72,
  "_printer._tcp": 72,
  "_pdl-datastream._tcp": 68,
  "_scanner._tcp": 58,
  "_http._tcp": 22,
  "_https._tcp": 24,
  "_smb._tcp": 24,
  "_afpovertcp._tcp": 24,
  "_nfs._tcp": 28,
  "_ssh._tcp": 24,
  "_sftp-ssh._tcp": 26,
  "_homekit._tcp": 60,
  "_hap._tcp": 60,
  "_hue._tcp": 62,
  "_mqtt._tcp": 55,
  "_coap._udp": 55,
  "_companion-link._tcp": 55,
  "_sleep-proxy._udp": 35,
  "_rtsp._tcp": 68,
  "_daap._tcp": 50,
  "_workstation._tcp": 50,
  "_device-info._tcp": 5,
  "_rdlink._tcp": 52,
};

// Build a DNS-SD browse query for _services._dns-sd._udp.local
function buildDnsSdBrowseQuery(): Buffer {
  // DNS header: ID=0, Flags=0, Questions=1, Answers=0, NS=0, AR=0
  const header = Buffer.from([
    0x00, 0x00, // ID
    0x00, 0x00, // Flags (standard query)
    0x00, 0x01, // Questions: 1
    0x00, 0x00, // Answer RRs: 0
    0x00, 0x00, // Authority RRs: 0
    0x00, 0x00, // Additional RRs: 0
  ]);

  // Question: _services._dns-sd._udp.local PTR
  const question = Buffer.from([
    0x09, // length 9
    ...Buffer.from("_services"),
    0x07, // length 7
    ...Buffer.from("_dns-sd"),
    0x04, // length 4
    ...Buffer.from("_udp"),
    0x05, // length 5
    ...Buffer.from("local"),
    0x00, // null terminator
    0x00, 0x0c, // Type: PTR
    0x00, 0x01, // Class: IN
  ]);

  return Buffer.concat([header, question]);
}

interface MdnsRecord {
  name: string;
  type: number;
  rdata: string;
}

function parseDnsName(buf: Buffer, offset: number): { name: string; newOffset: number } {
  const parts: string[] = [];
  let jumped = false;
  let returnOffset = offset;
  let current = offset;

  while (current < buf.length) {
    const len = buf[current]!;
    if (len === 0) {
      if (!jumped) returnOffset = current + 1;
      break;
    }
    // Pointer (compression)
    if ((len & 0xc0) === 0xc0) {
      if (!jumped) returnOffset = current + 2;
      current = ((len & 0x3f) << 8) | buf[current + 1]!;
      jumped = true;
      continue;
    }
    current++;
    if (current + len > buf.length) break;
    parts.push(buf.subarray(current, current + len).toString("utf-8"));
    current += len;
  }

  return { name: parts.join("."), newOffset: jumped ? returnOffset : current + 1 };
}

function parseMdnsResponse(buf: Buffer): MdnsRecord[] {
  const records: MdnsRecord[] = [];

  if (buf.length < 12) return records;

  const qdcount = buf.readUInt16BE(4);
  const ancount = buf.readUInt16BE(6);
  const nscount = buf.readUInt16BE(8);
  const arcount = buf.readUInt16BE(10);

  let offset = 12;

  // Skip questions
  for (let i = 0; i < qdcount && offset < buf.length; i++) {
    const { newOffset } = parseDnsName(buf, offset);
    offset = newOffset + 4; // skip type + class
  }

  // Parse answer, authority, and additional records
  const totalRecords = ancount + nscount + arcount;
  for (let i = 0; i < totalRecords && offset < buf.length; i++) {
    const { name, newOffset } = parseDnsName(buf, offset);
    offset = newOffset;

    if (offset + 10 > buf.length) break;

    const type = buf.readUInt16BE(offset);
    offset += 4; // skip type + class
    offset += 4; // skip TTL
    const rdlength = buf.readUInt16BE(offset);
    offset += 2;

    if (offset + rdlength > buf.length) break;

    let rdata = "";
    if (type === 12) {
      // PTR record
      const { name: ptrName } = parseDnsName(buf, offset);
      rdata = ptrName;
    } else if (type === 33) {
      // SRV record - priority(2) + weight(2) + port(2) + target
      if (rdlength >= 6) {
        const { name: target } = parseDnsName(buf, offset + 6);
        const port = buf.readUInt16BE(offset + 4);
        rdata = `${target}:${port}`;
      }
    } else if (type === 16) {
      // TXT record
      let txtOffset = offset;
      const txtParts: string[] = [];
      const txtEnd = offset + rdlength;
      while (txtOffset < txtEnd) {
        const txtLen = buf[txtOffset]!;
        txtOffset++;
        if (txtOffset + txtLen > txtEnd) break;
        txtParts.push(buf.subarray(txtOffset, txtOffset + txtLen).toString("utf-8"));
        txtOffset += txtLen;
      }
      rdata = txtParts.join("; ");
    } else if (type === 1) {
      // A record
      if (rdlength === 4) {
        rdata = `${buf[offset]}.${buf[offset + 1]}.${buf[offset + 2]}.${buf[offset + 3]}`;
      }
    }

    if (rdata) {
      records.push({ name, type, rdata });
    }

    offset += rdlength;
  }

  return records;
}

export async function discoverMdns(timeoutMs = 5000): Promise<DiscoveryCandidate[]> {
  return new Promise((resolve) => {
    const candidates = new Map<string, DiscoveryCandidate>();

    let socket: dgram.Socket;
    try {
      socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    } catch {
      resolve([]);
      return;
    }

    const timer = setTimeout(() => {
      try { socket.close(); } catch { /* noop */ }
      resolve(Array.from(candidates.values()));
    }, timeoutMs);

    socket.on("error", () => {
      clearTimeout(timer);
      try { socket.close(); } catch { /* noop */ }
      resolve(Array.from(candidates.values()));
    });

    socket.on("message", (msg, rinfo) => {
      const ip = rinfo.address;
      const records = parseMdnsResponse(msg);
      const services: string[] = [];

      for (const record of records) {
        if (record.type === 12) {
          // PTR record: the rdata is a service instance name
          const serviceType = record.name;
          if (serviceType && !serviceType.startsWith("_services.")) {
            services.push(serviceType);
          }
        }
      }

      if (services.length === 0) return;

      const existing = candidates.get(ip);
      const allServices = existing
        ? [...new Set([...(existing.metadata.mdnsServices as string[] || []), ...services])]
        : services;

      // Try to extract a hostname from SRV records
      let hostname: string | undefined;
      for (const record of records) {
        if (record.type === 33 && record.rdata) {
          const srvTarget = record.rdata.split(":")[0];
          if (srvTarget && srvTarget !== ip && !srvTarget.endsWith(".")) {
            hostname = srvTarget;
            break;
          }
          if (srvTarget?.endsWith(".local.") || srvTarget?.endsWith(".local")) {
            hostname = srvTarget.replace(/\.local\.?$/, "");
            break;
          }
        }
      }

      // Extract friendly name from TXT records
      let friendlyName: string | undefined;
      for (const record of records) {
        if (record.type === 16 && record.rdata) {
          const fnMatch = record.rdata.match(/fn=([^;]+)/);
          if (fnMatch) {
            friendlyName = fnMatch[1]?.trim();
            break;
          }
          const mdMatch = record.rdata.match(/md=([^;]+)/);
          if (mdMatch && !friendlyName) {
            friendlyName = mdMatch[1]?.trim();
          }
        }
      }

      // Determine type hint from the aggregate set of announced services.
      const typeScores = new Map<DeviceType, number>();
      for (const svc of allServices) {
        const mapping = MDNS_SERVICE_TYPE_MAP[svc];
        if (!mapping || mapping.type === "unknown") continue;
        const weight = MDNS_TYPE_HINT_WEIGHT[svc] ?? 20;
        typeScores.set(mapping.type, (typeScores.get(mapping.type) ?? 0) + weight);
      }
      const typeHint = [...typeScores.entries()]
        .sort((a, b) => b[1] - a[1])[0]?.[0];

      candidates.set(ip, {
        ip,
        hostname: hostname ?? existing?.hostname,
        typeHint: typeHint ?? existing?.typeHint,
        services: existing?.services ?? [],
        source: "mdns",
        observations: [
          ...(existing?.observations ?? []),
          buildObservation({
            ip,
            source: "mdns",
            evidenceType: "mdns_announcement",
            confidence: 0.9,
            observedAt: new Date().toISOString(),
            ttlMs: 20 * 60_000,
            details: {
              services: allServices.slice(0, 20),
              friendlyName,
            },
          }),
        ],
        metadata: {
          mdnsServices: allServices,
          mdnsFriendlyName: friendlyName ?? (existing?.metadata.mdnsFriendlyName as string | undefined),
          typeHintSource: "mdns",
        },
      });
    });

    socket.bind(0, () => {
      try {
        socket.addMembership(MDNS_ADDR);
        socket.send(buildDnsSdBrowseQuery(), MDNS_PORT, MDNS_ADDR);
      } catch {
        clearTimeout(timer);
        try { socket.close(); } catch { /* noop */ }
        resolve([]);
      }
    });
  });
}

/* ---------- SSDP / UPnP ---------- */

const SSDP_ADDR = "239.255.255.250";
const SSDP_PORT = 1900;

const SSDP_MSEARCH = Buffer.from(
  [
    "M-SEARCH * HTTP/1.1",
    `HOST: ${SSDP_ADDR}:${SSDP_PORT}`,
    'MAN: "ssdp:discover"',
    "MX: 3",
    "ST: ssdp:all",
    "",
    "",
  ].join("\r\n"),
);

interface SsdpResponse {
  ip: string;
  location?: string;
  server?: string;
  st?: string;
}

function parseSsdpResponse(msg: Buffer, rinfo: { address: string }): SsdpResponse | undefined {
  const text = msg.toString("utf-8");
  if (!text.startsWith("HTTP/1.1 200") && !text.startsWith("NOTIFY")) return undefined;

  const headers = new Map<string, string>();
  for (const line of text.split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) {
      headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
    }
  }

  return {
    ip: rinfo.address,
    location: headers.get("location"),
    server: headers.get("server"),
    st: headers.get("st"),
  };
}

interface UpnpDeviceInfo {
  friendlyName?: string;
  manufacturer?: string;
  modelName?: string;
  modelNumber?: string;
  deviceType?: string;
}

async function fetchUpnpDescription(url: string, timeoutMs = 3000): Promise<UpnpDeviceInfo | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (v: UpnpDeviceInfo | undefined) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf-8");
      res.on("data", (chunk: string) => {
        body += chunk;
        if (body.length > 16384) res.destroy();
      });
      res.on("end", () => {
        const extract = (tag: string): string | undefined => {
          const match = body.match(new RegExp(`<${tag}>([^<]{1,300})</${tag}>`, "i"));
          return match?.[1]?.trim();
        };
        settle({
          friendlyName: extract("friendlyName"),
          manufacturer: extract("manufacturer"),
          modelName: extract("modelName"),
          modelNumber: extract("modelNumber"),
          deviceType: extract("deviceType"),
        });
      });
      res.on("error", () => settle(undefined));
    });
    req.on("error", () => settle(undefined));
    req.on("timeout", () => { req.destroy(); settle(undefined); });
  });
}

function ssdpDeviceTypeToDeviceType(urnOrServer: string): DeviceType | undefined {
  const lower = urnOrServer.toLowerCase();
  if (lower.includes("mediaserver") || lower.includes("mediarenderer")) return "iot";
  if (lower.includes("internetgatewaydevice") || lower.includes("wanconnectiondevice")) return "router";
  if (lower.includes("printer")) return "printer";
  if (lower.includes("scanner")) return "printer";
  if (lower.includes("securitycamera") || lower.includes("digitalcamera")) return "camera";
  if (lower.includes("storagedevice") || lower.includes("contentdirectory")) return "nas";
  if (lower.includes("wlanaccess")) return "access-point";
  return undefined;
}

export async function discoverSsdp(timeoutMs = 5000): Promise<DiscoveryCandidate[]> {
  return new Promise((resolve) => {
    const responsesByIp = new Map<string, SsdpResponse[]>();

    let socket: dgram.Socket;
    try {
      socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    } catch {
      resolve([]);
      return;
    }

    const timer = setTimeout(async () => {
      try { socket.close(); } catch { /* noop */ }

      // Fetch UPnP descriptions for unique locations
      const allLocations = new Map<string, string>(); // location -> ip
      for (const [ip, responses] of responsesByIp) {
        for (const r of responses) {
          if (r.location && !allLocations.has(r.location)) {
            allLocations.set(r.location, ip);
          }
        }
      }

      const descriptions = new Map<string, UpnpDeviceInfo>();
      const descFetches = [...allLocations.entries()].slice(0, 30).map(async ([loc]) => {
        const info = await fetchUpnpDescription(loc, 3000);
        if (info) descriptions.set(loc, info);
      });
      await Promise.all(descFetches);

      // Build candidates
      const candidates: DiscoveryCandidate[] = [];

      for (const [ip, responses] of responsesByIp) {
        const sts = responses.map((r) => r.st).filter(Boolean) as string[];
        const serverHeader = responses.find((r) => r.server)?.server;

        // Find best description
        let bestDesc: UpnpDeviceInfo | undefined;
        for (const r of responses) {
          if (r.location) {
            const desc = descriptions.get(r.location);
            if (desc?.friendlyName) {
              bestDesc = desc;
              break;
            }
            if (desc && !bestDesc) bestDesc = desc;
          }
        }

        // Infer device type
        let typeHint: DeviceType | undefined;
        for (const st of sts) {
          typeHint = ssdpDeviceTypeToDeviceType(st);
          if (typeHint) break;
        }
        if (!typeHint && bestDesc?.deviceType) {
          typeHint = ssdpDeviceTypeToDeviceType(bestDesc.deviceType);
        }
        if (!typeHint && serverHeader) {
          typeHint = ssdpDeviceTypeToDeviceType(serverHeader);
        }

        candidates.push({
          ip,
          hostname: bestDesc?.friendlyName?.replace(/\s+/g, "-").toLowerCase(),
          vendor: bestDesc?.manufacturer,
          typeHint,
          services: [],
          source: "ssdp",
          observations: [
            buildObservation({
              ip,
              source: "ssdp",
              evidenceType: "ssdp_response",
              confidence: 0.88,
              observedAt: new Date().toISOString(),
              ttlMs: 20 * 60_000,
              details: {
                deviceType: bestDesc?.deviceType,
                friendlyName: bestDesc?.friendlyName,
                modelName: bestDesc?.modelName,
                st: sts.slice(0, 20),
              },
            }),
          ],
          metadata: {
            ssdpDeviceType: bestDesc?.deviceType,
            ssdpFriendlyName: bestDesc?.friendlyName,
            ssdpModelName: bestDesc?.modelName,
            ssdpManufacturer: bestDesc?.manufacturer,
            ssdpServer: serverHeader,
            ssdpServiceTypes: sts,
            typeHintSource: "ssdp",
          },
        });
      }

      resolve(candidates);
    }, timeoutMs);

    socket.on("error", () => {
      clearTimeout(timer);
      try { socket.close(); } catch { /* noop */ }
      resolve([]);
    });

    socket.on("message", (msg, rinfo) => {
      const parsed = parseSsdpResponse(msg, rinfo);
      if (!parsed) return;

      const existing = responsesByIp.get(parsed.ip) ?? [];
      existing.push(parsed);
      responsesByIp.set(parsed.ip, existing);
    });

    socket.bind(0, () => {
      try {
        socket.send(SSDP_MSEARCH, SSDP_PORT, SSDP_ADDR);
        // Send twice for reliability
        setTimeout(() => {
          try { socket.send(SSDP_MSEARCH, SSDP_PORT, SSDP_ADDR); } catch { /* noop */ }
        }, 500);
      } catch {
        clearTimeout(timer);
        try { socket.close(); } catch { /* noop */ }
        resolve([]);
      }
    });
  });
}

/* ---------- Combined Multicast Discovery ---------- */

export async function discoverMulticast(
  timeoutMs = 5000,
  options?: { enableMdns?: boolean; enableSsdp?: boolean },
): Promise<DiscoveryCandidate[]> {
  const enableMdns = options?.enableMdns ?? true;
  const enableSsdp = options?.enableSsdp ?? true;

  const results = await Promise.all([
    enableMdns ? discoverMdns(timeoutMs) : [],
    enableSsdp ? discoverSsdp(timeoutMs) : [],
  ]);

  // Merge by IP
  const byIp = new Map<string, DiscoveryCandidate>();

  for (const candidates of results) {
    for (const candidate of candidates) {
      const existing = byIp.get(candidate.ip);
      if (!existing) {
        byIp.set(candidate.ip, candidate);
        continue;
      }
      byIp.set(candidate.ip, {
        ...existing,
        hostname: existing.hostname ?? candidate.hostname,
        vendor: existing.vendor ?? candidate.vendor,
        typeHint: existing.typeHint ?? candidate.typeHint,
        services: [...existing.services, ...candidate.services],
        observations: [...existing.observations, ...candidate.observations],
        metadata: { ...existing.metadata, ...candidate.metadata },
      });
    }
  }

  return Array.from(byIp.values());
}
