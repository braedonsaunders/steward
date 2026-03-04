import { randomUUID } from "node:crypto";
import dgram from "node:dgram";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import type { DiscoveryCandidate } from "@/lib/discovery/types";
import type { HttpInfo, ServiceFingerprint, TlsCertInfo } from "@/lib/state/types";

/* ---------- SSH Banner ---------- */

const grabSshBanner = (ip: string, port = 22, timeoutMs = 2000): Promise<string | undefined> =>
  new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const settle = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("data", (chunk) => {
      const line = chunk.toString("utf-8").split("\n")[0]?.trim();
      settle(line || undefined);
    });
    socket.once("timeout", () => settle(undefined));
    socket.once("error", () => settle(undefined));
    socket.once("close", () => settle(undefined));
    socket.connect(port, ip);
  });

/* ---------- Generic TCP Banner ---------- */

const grabTcpBanner = (ip: string, port: number, timeoutMs = 2000): Promise<string | undefined> =>
  new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const settle = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("data", (chunk) => {
      const text = chunk.toString("utf-8").slice(0, 512).trim();
      settle(text || undefined);
    });
    socket.once("timeout", () => settle(undefined));
    socket.once("error", () => settle(undefined));
    socket.once("close", () => settle(undefined));
    socket.connect(port, ip);
  });

/* ---------- TLS Certificate ---------- */

const grabTlsCert = (ip: string, port: number, timeoutMs = 3000): Promise<TlsCertInfo | undefined> =>
  new Promise((resolve) => {
    let settled = false;
    const settle = (value: TlsCertInfo | undefined) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const socket = tls.connect(
      { host: ip, port, rejectUnauthorized: false, timeout: timeoutMs, servername: ip },
      () => {
        try {
          const cert = socket.getPeerCertificate();
          socket.destroy();
          if (!cert || !cert.subject) {
            settle(undefined);
            return;
          }
          const rawSubject = cert.subject.CN;
          const subjectCN = Array.isArray(rawSubject) ? rawSubject[0] ?? "" : rawSubject ?? "";
          const rawIssuer = cert.issuer?.CN;
          const issuerCN = Array.isArray(rawIssuer) ? rawIssuer[0] ?? "" : rawIssuer ?? "";
          settle({
            subject: subjectCN,
            issuer: issuerCN,
            validFrom: cert.valid_from ?? "",
            validTo: cert.valid_to ?? "",
            sans: (cert.subjectaltname ?? "")
              .split(",")
              .map((s: string) => s.trim().replace(/^DNS:/, ""))
              .filter(Boolean),
            selfSigned: subjectCN === issuerCN,
          });
        } catch {
          socket.destroy();
          settle(undefined);
        }
      },
    );
    socket.once("error", () => { socket.destroy(); settle(undefined); });
    socket.once("timeout", () => { socket.destroy(); settle(undefined); });
  });

/* ---------- HTTP Banner ---------- */

const grabHttpInfo = (ip: string, port: number, secure: boolean, timeoutMs = 3000): Promise<HttpInfo | undefined> =>
  new Promise((resolve) => {
    const protocol = secure ? https : http;
    let settled = false;
    const settle = (value: HttpInfo | undefined) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const req = protocol.get(
      {
        hostname: ip,
        port,
        path: "/",
        timeout: timeoutMs,
        rejectUnauthorized: false,
        headers: { "User-Agent": "Steward/1.0 (Network Discovery)" },
      },
      (res) => {
        const serverHeader = (res.headers["server"] as string) ?? undefined;
        const poweredBy = (res.headers["x-powered-by"] as string) ?? undefined;
        let body = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk: string) => {
          body += chunk;
          if (body.length > 8192) res.destroy();
        });
        res.on("end", () => {
          const titleMatch = body.match(/<title[^>]*>([^<]{1,200})<\/title>/i);
          const generatorMatch =
            body.match(/content="([^"]{1,200})"[^>]*name="generator"/i) ??
            body.match(/name="generator"[^>]*content="([^"]{1,200})"/i);
          settle({
            serverHeader: serverHeader || undefined,
            poweredBy: poweredBy || undefined,
            title: titleMatch?.[1]?.trim(),
            generator: generatorMatch?.[1]?.trim(),
            redirectsTo:
              res.statusCode && res.statusCode >= 300 && res.statusCode < 400
                ? (res.headers.location ?? undefined)
                : undefined,
          });
        });
        res.on("error", () => settle({ serverHeader: serverHeader || undefined, poweredBy: poweredBy || undefined }));
      },
    );
    req.on("error", () => settle(undefined));
    req.on("timeout", () => { req.destroy(); settle(undefined); });
  });

/* ---------- SNMP sysDescr / sysName ---------- */

// BER-encoded SNMPv2c GET-REQUEST for OID 1.3.6.1.2.1.1.1.0 (sysDescr) with community "public"
const SNMP_SYSDESCR_PACKET = Buffer.from([
  0x30, 0x29,                               // SEQUENCE (41 bytes)
  0x02, 0x01, 0x01,                         // INTEGER: version = 1 (SNMPv2c)
  0x04, 0x06, 0x70, 0x75, 0x62, 0x6c, 0x69, 0x63, // OCTET STRING: "public"
  0xa0, 0x1c,                               // GetRequest-PDU (28 bytes)
  0x02, 0x04, 0x00, 0x00, 0x00, 0x01,       // INTEGER: request-id = 1
  0x02, 0x01, 0x00,                         // INTEGER: error-status = 0
  0x02, 0x01, 0x00,                         // INTEGER: error-index = 0
  0x30, 0x0e,                               // SEQUENCE: varbind list
  0x30, 0x0c,                               // SEQUENCE: varbind
  0x06, 0x08, 0x2b, 0x06, 0x01, 0x02, 0x01, 0x01, 0x01, 0x00, // OID: 1.3.6.1.2.1.1.1.0
  0x05, 0x00,                               // NULL value
]);

// BER-encoded SNMPv2c GET-REQUEST for OID 1.3.6.1.2.1.1.5.0 (sysName)
const SNMP_SYSNAME_PACKET = Buffer.from([
  0x30, 0x29,
  0x02, 0x01, 0x01,
  0x04, 0x06, 0x70, 0x75, 0x62, 0x6c, 0x69, 0x63,
  0xa0, 0x1c,
  0x02, 0x04, 0x00, 0x00, 0x00, 0x02,
  0x02, 0x01, 0x00,
  0x02, 0x01, 0x00,
  0x30, 0x0e,
  0x30, 0x0c,
  0x06, 0x08, 0x2b, 0x06, 0x01, 0x02, 0x01, 0x01, 0x05, 0x00,
  0x05, 0x00,
]);

function parseSnmpOctetString(msg: Buffer): string | undefined {
  // Walk the BER to find the value in the varbind response
  // Format: SEQUENCE > version > community > GetResponse-PDU > ... > varbind > OID > value
  try {
    let offset = 0;
    // Skip outer SEQUENCE tag+length
    if (msg[offset] !== 0x30) return undefined;
    offset++;
    if (msg[offset]! & 0x80) {
      offset += (msg[offset]! & 0x7f) + 1;
    } else {
      offset++;
    }
    // Skip version
    if (msg[offset] !== 0x02) return undefined;
    offset += 2 + msg[offset + 1]!;
    // Skip community string
    if (msg[offset] !== 0x04) return undefined;
    offset += 2 + msg[offset + 1]!;
    // Skip GetResponse PDU tag+length
    if ((msg[offset]! & 0xf0) !== 0xa0) return undefined;
    offset++;
    if (msg[offset]! & 0x80) {
      offset += (msg[offset]! & 0x7f) + 1;
    } else {
      offset++;
    }
    // Skip request-id, error-status, error-index
    for (let i = 0; i < 3; i++) {
      if (msg[offset] !== 0x02) return undefined;
      offset += 2 + msg[offset + 1]!;
    }
    // Skip varbind list SEQUENCE
    if (msg[offset] !== 0x30) return undefined;
    offset++;
    if (msg[offset]! & 0x80) {
      offset += (msg[offset]! & 0x7f) + 1;
    } else {
      offset++;
    }
    // Skip varbind SEQUENCE
    if (msg[offset] !== 0x30) return undefined;
    offset++;
    if (msg[offset]! & 0x80) {
      offset += (msg[offset]! & 0x7f) + 1;
    } else {
      offset++;
    }
    // Skip OID
    if (msg[offset] !== 0x06) return undefined;
    offset += 2 + msg[offset + 1]!;
    // Now we should be at the value
    const valueTag = msg[offset]!;
    const valueLen = msg[offset + 1]!;
    if (valueTag === 0x04) {
      // OCTET STRING
      return msg.subarray(offset + 2, offset + 2 + valueLen).toString("utf-8");
    }
    return undefined;
  } catch {
    return undefined;
  }
}

const sendSnmpQuery = (ip: string, packet: Buffer, timeoutMs = 2000): Promise<string | undefined> =>
  new Promise((resolve) => {
    let settled = false;
    const settle = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const socket = dgram.createSocket("udp4");
    const timer = setTimeout(() => {
      socket.close();
      settle(undefined);
    }, timeoutMs);

    socket.on("message", (msg) => {
      clearTimeout(timer);
      socket.close();
      settle(parseSnmpOctetString(msg));
    });
    socket.on("error", () => {
      clearTimeout(timer);
      try { socket.close(); } catch { /* noop */ }
      settle(undefined);
    });
    socket.send(packet, 161, ip);
  });

export const grabSnmpInfo = async (
  ip: string,
  timeoutMs = 2000,
): Promise<{ sysDescr?: string; sysName?: string }> => {
  const [sysDescr, sysName] = await Promise.all([
    sendSnmpQuery(ip, SNMP_SYSDESCR_PACKET, timeoutMs),
    sendSnmpQuery(ip, SNMP_SYSNAME_PACKET, timeoutMs),
  ]);
  return { sysDescr, sysName };
};

/* ---------- OS Inference from Banners ---------- */

export function inferOsFromBanner(banner: string): string | undefined {
  const lower = banner.toLowerCase();

  // SSH banners
  if (lower.includes("ubuntu")) return "Ubuntu";
  if (lower.includes("debian")) return "Debian";
  if (/el[6-9]|\.el\d|centos|rhel|red\s*hat/.test(lower)) return "RHEL/CentOS";
  if (lower.includes("fedora")) return "Fedora";
  if (lower.includes("freebsd")) return "FreeBSD";
  if (lower.includes("openbsd")) return "OpenBSD";
  if (lower.includes("alpine")) return "Alpine Linux";
  if (lower.includes("arch")) return "Arch Linux";
  if (lower.includes("opensuse") || lower.includes("suse")) return "SUSE Linux";
  if (lower.includes("raspbian") || lower.includes("raspberry")) return "Raspberry Pi OS";

  // HTTP Server headers
  if (lower.includes("microsoft-iis")) return "Windows Server";
  if (lower.includes("microsoft-httpapi")) return "Windows";
  if (lower.includes("synology")) return "Synology DSM";
  if (lower.includes("qnap")) return "QNAP QTS";

  // SNMP sysDescr
  if (lower.includes("linux")) return "Linux";
  if (lower.includes("windows")) return "Windows";
  if (lower.includes("darwin") || lower.includes("macos")) return "macOS";
  if (lower.includes("cisco ios")) return "Cisco IOS";
  if (lower.includes("junos")) return "Juniper Junos";
  if (lower.includes("routeros") || lower.includes("mikrotik")) return "MikroTik RouterOS";
  if (lower.includes("fortios") || lower.includes("fortigate")) return "Fortinet FortiOS";
  if (lower.includes("edgeos") || lower.includes("ubiquiti")) return "Ubiquiti EdgeOS";
  if (lower.includes("unifi") || lower.includes("ubnt")) return "Ubiquiti UniFi";
  if (lower.includes("panos") || lower.includes("palo alto")) return "Palo Alto PAN-OS";
  if (lower.includes("vmware") || lower.includes("esxi")) return "VMware ESXi";
  if (lower.includes("proxmox")) return "Proxmox VE";
  if (lower.includes("truenas") || lower.includes("freenas")) return "TrueNAS";
  if (lower.includes("opnsense")) return "OPNsense";
  if (lower.includes("pfsense")) return "pfSense";
  if (lower.includes("openwrt")) return "OpenWrt";
  if (lower.includes("dd-wrt")) return "DD-WRT";
  if (lower.includes("asuswrt")) return "ASUSWRT";

  return undefined;
}

/* ---------- Product/Model Inference from Banners ---------- */

export function inferProductFromBanners(data: {
  sshBanner?: string;
  httpServerHeader?: string;
  httpTitle?: string;
  snmpSysDescr?: string;
  tlsSubject?: string;
}): string | undefined {
  const { sshBanner, httpServerHeader, httpTitle, snmpSysDescr, tlsSubject } = data;

  // SNMP sysDescr is the most informative
  if (snmpSysDescr) {
    const ciscoMatch = snmpSysDescr.match(/Cisco\s+([\w-]+)\s+Software/i);
    if (ciscoMatch) return `Cisco ${ciscoMatch[1]}`;

    const synologyMatch = snmpSysDescr.match(/(Synology\s+\w+)/i);
    if (synologyMatch) return synologyMatch[1];

    const qnapMatch = snmpSysDescr.match(/(QNAP\s+[\w-]+)/i);
    if (qnapMatch) return qnapMatch[1];
  }

  // HTTP title often reveals the product
  if (httpTitle) {
    const unifiMatch = httpTitle.match(/UniFi/i);
    if (unifiMatch) return "Ubiquiti UniFi";

    if (/synology/i.test(httpTitle)) return "Synology NAS";
    if (/qnap/i.test(httpTitle)) return "QNAP NAS";
    if (/proxmox/i.test(httpTitle)) return "Proxmox VE";
    if (/pfsense/i.test(httpTitle)) return "pfSense";
    if (/opnsense/i.test(httpTitle)) return "OPNsense";
    if (/pihole/i.test(httpTitle)) return "Pi-hole";
    if (/home\s*assistant/i.test(httpTitle)) return "Home Assistant";
    if (/grafana/i.test(httpTitle)) return "Grafana";
    if (/jenkins/i.test(httpTitle)) return "Jenkins";
    if (/gitlab/i.test(httpTitle)) return "GitLab";
    if (/nextcloud/i.test(httpTitle)) return "Nextcloud";
    if (/truenas/i.test(httpTitle)) return "TrueNAS";
    if (/idrac/i.test(httpTitle)) return "Dell iDRAC";
    if (/ilo/i.test(httpTitle)) return "HPE iLO";
    if (/ipmi/i.test(httpTitle)) return "IPMI BMC";
  }

  // TLS certificate subject
  if (tlsSubject) {
    if (/unifi/i.test(tlsSubject)) return "Ubiquiti UniFi";
    if (/synology/i.test(tlsSubject)) return "Synology NAS";
    if (/idrac/i.test(tlsSubject)) return "Dell iDRAC";
  }

  // SSH banner version
  if (sshBanner) {
    const dropbear = sshBanner.match(/dropbear[_-](\S+)/i);
    if (dropbear) return `Dropbear SSH ${dropbear[1]}`;
  }

  // HTTP Server header
  if (httpServerHeader) {
    if (/apache/i.test(httpServerHeader)) return `Apache ${httpServerHeader.match(/Apache\/([\d.]+)/)?.[1] ?? ""}`.trim();
    if (/nginx/i.test(httpServerHeader)) return `nginx ${httpServerHeader.match(/nginx\/([\d.]+)/)?.[1] ?? ""}`.trim();
    if (/microsoft-iis/i.test(httpServerHeader)) return `IIS ${httpServerHeader.match(/IIS\/([\d.]+)/)?.[1] ?? ""}`.trim();
    if (/lighttpd/i.test(httpServerHeader)) return "lighttpd";
    if (/caddy/i.test(httpServerHeader)) return "Caddy";
  }

  return undefined;
}

/* ---------- Batch Fingerprinting ---------- */

const BANNER_PORTS = new Set([21, 23, 25, 110, 143]);
const HTTP_PORTS = new Set([80, 8080, 8000, 9000]);
const HTTPS_PORTS = new Set([443, 8443, 7443, 9443, 5001]);
const SSH_PORTS = new Set([22, 2222]);

export interface FingerprintResult {
  ip: string;
  services: ServiceFingerprint[];
  sshBanner?: string;
  snmpSysDescr?: string;
  snmpSysName?: string;
  inferredOs?: string;
  inferredProduct?: string;
}

export async function fingerprintDevice(
  candidate: DiscoveryCandidate,
  options?: { timeoutMs?: number; enableSnmp?: boolean },
): Promise<FingerprintResult> {
  const timeoutMs = options?.timeoutMs ?? 3000;
  const enableSnmp = options?.enableSnmp ?? true;
  const ports = new Set(candidate.services.map((s) => s.port));

  const enrichedServices = [...candidate.services];
  let sshBanner: string | undefined;
  let snmpInfo: { sysDescr?: string; sysName?: string } = {};
  let primaryHttpInfo: HttpInfo | undefined;
  let primaryTlsCert: TlsCertInfo | undefined;

  // SSH banner grab
  const sshPort = [...SSH_PORTS].find((p) => ports.has(p));
  if (sshPort) {
    sshBanner = await grabSshBanner(candidate.ip, sshPort, timeoutMs);
    if (sshBanner) {
      const svc = enrichedServices.find((s) => s.port === sshPort);
      if (svc) svc.banner = sshBanner;
    }
  }

  // TLS cert grab (first HTTPS port found)
  const tlsPort = [...HTTPS_PORTS].find((p) => ports.has(p));
  if (tlsPort) {
    primaryTlsCert = await grabTlsCert(candidate.ip, tlsPort, timeoutMs);
    if (primaryTlsCert) {
      const svc = enrichedServices.find((s) => s.port === tlsPort);
      if (svc) svc.tlsCert = primaryTlsCert;
    }
  }

  // HTTP banner grab (try HTTPS first, then HTTP)
  const httpsPort = [...HTTPS_PORTS].find((p) => ports.has(p));
  const httpPort = [...HTTP_PORTS].find((p) => ports.has(p));
  const targetHttpPort = httpsPort ?? httpPort;
  const isSecure = httpsPort !== undefined;

  if (targetHttpPort) {
    primaryHttpInfo = await grabHttpInfo(candidate.ip, targetHttpPort, isSecure, timeoutMs);
    if (primaryHttpInfo) {
      const svc = enrichedServices.find((s) => s.port === targetHttpPort);
      if (svc) svc.httpInfo = primaryHttpInfo;
    }
  }

  // SNMP probe
  if (enableSnmp && ports.has(161)) {
    snmpInfo = await grabSnmpInfo(candidate.ip, timeoutMs);
  }

  // Generic TCP banners for text-based protocols
  for (const port of BANNER_PORTS) {
    if (ports.has(port)) {
      const banner = await grabTcpBanner(candidate.ip, port, timeoutMs);
      if (banner) {
        const svc = enrichedServices.find((s) => s.port === port);
        if (svc) svc.banner = banner;
      }
    }
  }

  // Infer OS from all collected banners
  const allBanners = [
    sshBanner,
    snmpInfo.sysDescr,
    primaryHttpInfo?.serverHeader,
    primaryHttpInfo?.title,
  ].filter(Boolean) as string[];

  let inferredOs: string | undefined;
  for (const banner of allBanners) {
    inferredOs = inferOsFromBanner(banner);
    if (inferredOs) break;
  }

  const inferredProduct = inferProductFromBanners({
    sshBanner,
    httpServerHeader: primaryHttpInfo?.serverHeader,
    httpTitle: primaryHttpInfo?.title,
    snmpSysDescr: snmpInfo.sysDescr,
    tlsSubject: primaryTlsCert?.subject,
  });

  return {
    ip: candidate.ip,
    services: enrichedServices,
    sshBanner,
    snmpSysDescr: snmpInfo.sysDescr,
    snmpSysName: snmpInfo.sysName,
    inferredOs,
    inferredProduct,
  };
}

export async function fingerprintBatch(
  candidates: DiscoveryCandidate[],
  options?: { maxConcurrency?: number; timeoutMs?: number; enableSnmp?: boolean },
): Promise<FingerprintResult[]> {
  const maxConcurrency = options?.maxConcurrency ?? 4;
  const results: FingerprintResult[] = [];

  for (let i = 0; i < candidates.length; i += maxConcurrency) {
    const batch = candidates.slice(i, i + maxConcurrency);
    const batchResults = await Promise.all(
      batch.map((c) => fingerprintDevice(c, options)),
    );
    results.push(...batchResults);
  }

  return results;
}

export function applyFingerprintResults(
  candidates: DiscoveryCandidate[],
  results: FingerprintResult[],
): DiscoveryCandidate[] {
  const byIp = new Map(results.map((r) => [r.ip, r]));

  return candidates.map((candidate) => {
    const fp = byIp.get(candidate.ip);
    if (!fp) return candidate;

    return {
      ...candidate,
      os: candidate.os ?? fp.inferredOs,
      services: fp.services,
      metadata: {
        ...candidate.metadata,
        fingerprint: {
          sshBanner: fp.sshBanner,
          snmpSysDescr: fp.snmpSysDescr,
          snmpSysName: fp.snmpSysName,
          inferredOs: fp.inferredOs,
          inferredProduct: fp.inferredProduct,
          lastFingerprintedAt: new Date().toISOString(),
          fingerprintVersion: 1,
        },
      },
    };
  });
}
