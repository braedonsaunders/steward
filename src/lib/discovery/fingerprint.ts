import { randomUUID } from "node:crypto";
import dgram from "node:dgram";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { buildObservation, dedupeObservations } from "@/lib/discovery/evidence";
import type { DiscoveryCandidate } from "@/lib/discovery/types";
import type {
  DiscoveryObservationInput,
  HttpInfo,
  ServiceFingerprint,
  TlsCertInfo,
} from "@/lib/state/types";

export const CURRENT_FINGERPRINT_VERSION = 3;

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

const exchangeTcpPayload = (
  ip: string,
  port: number,
  payload: Buffer | undefined,
  timeoutMs = 2000,
): Promise<Buffer | undefined> =>
  new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const settle = (value: Buffer | undefined) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      if (payload && payload.length > 0) {
        socket.write(payload);
      }
    });
    socket.once("data", (chunk) => settle(Buffer.from(chunk)));
    socket.once("timeout", () => settle(undefined));
    socket.once("error", () => settle(undefined));
    socket.once("close", () => settle(undefined));
    socket.connect(port, ip);
  });

const grabTcpBanner = (ip: string, port: number, timeoutMs = 2000): Promise<string | undefined> =>
  exchangeTcpPayload(ip, port, undefined, timeoutMs).then((chunk) =>
    chunk ? chunk.toString("utf-8").slice(0, 512).trim() || undefined : undefined,
  );

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
      {
        host: ip,
        port,
        rejectUnauthorized: false,
        timeout: timeoutMs,
        // Node will otherwise infer SNI from `host`, which breaks on IP literals.
        servername: net.isIP(ip) ? "" : ip,
      },
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

const probeWinRm = async (
  ip: string,
  port: number,
  secure: boolean,
  timeoutMs = 2500,
): Promise<{ statusCode?: number; server?: string; authHeader?: string } | undefined> =>
  new Promise((resolve) => {
    const protocol = secure ? https : http;
    let settled = false;
    const settle = (value: { statusCode?: number; server?: string; authHeader?: string } | undefined) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const req = protocol.request(
      {
        hostname: ip,
        port,
        path: "/wsman",
        method: "OPTIONS",
        timeout: timeoutMs,
        rejectUnauthorized: false,
        headers: {
          "User-Agent": "Steward/1.0",
        },
      },
      (res) => {
        const statusCode = res.statusCode;
        const server = typeof res.headers.server === "string" ? res.headers.server : undefined;
        const authHeader = typeof res.headers["www-authenticate"] === "string"
          ? res.headers["www-authenticate"]
          : Array.isArray(res.headers["www-authenticate"])
            ? res.headers["www-authenticate"][0]
            : undefined;
        res.resume();
        if (
          statusCode === 401 ||
          statusCode === 200 ||
          statusCode === 405 ||
          /wsman|microsoft-httpapi/i.test(`${server ?? ""} ${authHeader ?? ""}`)
        ) {
          settle({ statusCode, server, authHeader });
          return;
        }
        settle(undefined);
      },
    );

    req.on("error", () => settle(undefined));
    req.on("timeout", () => {
      req.destroy();
      settle(undefined);
    });
    req.end();
  });

const MQTT_CONNECT_PACKET = Buffer.from([
  0x10, 0x13, // CONNECT, remaining length
  0x00, 0x04, 0x4d, 0x51, 0x54, 0x54, // "MQTT"
  0x04, // protocol level
  0x02, // clean session
  0x00, 0x05, // keepalive
  0x00, 0x07, // client id length
  0x73, 0x74, 0x65, 0x77, 0x61, 0x72, 0x64, // "steward"
]);

const probeMqttBroker = async (
  ip: string,
  port: number,
  timeoutMs = 2000,
): Promise<{ returnCode?: number } | undefined> => {
  const chunk = await exchangeTcpPayload(ip, port, MQTT_CONNECT_PACKET, timeoutMs);
  if (!chunk || chunk.length < 4) {
    return undefined;
  }
  if (chunk[0] !== 0x20 || chunk[1] !== 0x02) {
    return undefined;
  }
  return { returnCode: chunk[3] };
};

const SMB_NEGOTIATE_PACKET = Buffer.from(
  "00000054ff534d4272000000001853c8000000000000000000000000ffff00000000003100024c414e4d414e312e3000024c4d312e325830303200024e54204c4d20302e313200",
  "hex",
);

const probeSmbNegotiate = async (
  ip: string,
  port = 445,
  timeoutMs = 2000,
): Promise<{ dialect?: string } | undefined> => {
  const chunk = await exchangeTcpPayload(ip, port, SMB_NEGOTIATE_PACKET, timeoutMs);
  if (!chunk || chunk.length < 8) {
    return undefined;
  }

  const signature = chunk.subarray(4, 8).toString("latin1");
  if (signature === "\xffSMB") {
    return { dialect: "smb1" };
  }
  if (signature === "\xfeSMB") {
    return { dialect: "smb2+" };
  }
  return undefined;
};

const encodeDnsName = (name: string): Buffer => {
  const labels = name.split(".").filter((value) => value.length > 0);
  const parts: number[] = [];
  for (const label of labels) {
    parts.push(label.length);
    for (const ch of Buffer.from(label, "ascii")) {
      parts.push(ch);
    }
  }
  parts.push(0);
  return Buffer.from(parts);
};

const buildDnsQueryPacket = (transactionId: number, name: string): Buffer => {
  const header = Buffer.from([
    (transactionId >> 8) & 0xff,
    transactionId & 0xff,
    0x01,
    0x00,
    0x00,
    0x01,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
  ]);
  const qname = encodeDnsName(name);
  const qtail = Buffer.from([0x00, 0x01, 0x00, 0x01]); // A IN
  return Buffer.concat([header, qname, qtail]);
};

const probeDnsService = (ip: string, timeoutMs = 1800): Promise<{ answers: number; rcode: number } | undefined> =>
  new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    const txid = Math.floor(Math.random() * 0xffff);
    const query = buildDnsQueryPacket(txid, "example.com");
    let settled = false;
    const settle = (value: { answers: number; rcode: number } | undefined) => {
      if (settled) return;
      settled = true;
      try { socket.close(); } catch { /* noop */ }
      resolve(value);
    };

    const timer = setTimeout(() => settle(undefined), timeoutMs);

    socket.on("error", () => {
      clearTimeout(timer);
      settle(undefined);
    });
    socket.on("message", (msg) => {
      clearTimeout(timer);
      if (msg.length < 12) {
        settle(undefined);
        return;
      }
      const responseTxid = msg.readUInt16BE(0);
      if (responseTxid !== txid) {
        settle(undefined);
        return;
      }
      const flags = msg.readUInt16BE(2);
      const ancount = msg.readUInt16BE(6);
      const rcode = flags & 0x000f;
      settle({ answers: ancount, rcode });
    });

    socket.send(query, 53, ip);
  });

const encodeNetbiosName = (name: string): Buffer => {
  const normalized = (name.toUpperCase() + "                ").slice(0, 16);
  const out: number[] = [32];
  for (const ch of normalized) {
    const code = ch.charCodeAt(0);
    out.push(0x41 + ((code >> 4) & 0x0f));
    out.push(0x41 + (code & 0x0f));
  }
  out.push(0x00);
  return Buffer.from(out);
};

const buildNetbiosQueryPacket = (transactionId: number): Buffer => {
  const header = Buffer.from([
    (transactionId >> 8) & 0xff,
    transactionId & 0xff,
    0x00,
    0x00,
    0x00,
    0x01,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
  ]);
  const qname = encodeNetbiosName("*");
  const qtail = Buffer.from([0x00, 0x21, 0x00, 0x01]); // NBSTAT IN
  return Buffer.concat([header, qname, qtail]);
};

const extractPrintableCandidates = (msg: Buffer): string[] => {
  const text = msg.toString("ascii");
  const matches = text.match(/[A-Z0-9][A-Z0-9 _-]{2,15}/g) ?? [];
  return Array.from(new Set(matches.map((item) => item.trim()).filter((item) => item.length >= 3))).slice(0, 8);
};

const probeNetbiosName = (ip: string, timeoutMs = 1800): Promise<{ name?: string } | undefined> =>
  new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    const txid = Math.floor(Math.random() * 0xffff);
    const query = buildNetbiosQueryPacket(txid);
    let settled = false;
    const settle = (value: { name?: string } | undefined) => {
      if (settled) return;
      settled = true;
      try { socket.close(); } catch { /* noop */ }
      resolve(value);
    };

    const timer = setTimeout(() => settle(undefined), timeoutMs);

    socket.on("error", () => {
      clearTimeout(timer);
      settle(undefined);
    });
    socket.on("message", (msg) => {
      clearTimeout(timer);
      if (msg.length < 12) {
        settle(undefined);
        return;
      }
      const responseTxid = msg.readUInt16BE(0);
      if (responseTxid !== txid) {
        settle(undefined);
        return;
      }
      const names = extractPrintableCandidates(msg);
      settle({ name: names[0] });
    });

    socket.send(query, 137, ip);
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
const DNS_PORTS = new Set([53]);
const WINRM_PORTS = new Set([5985, 5986]);
const MQTT_PORTS = new Set([1883, 8883]);
const SMB_PORTS = new Set([445]);
const NETBIOS_PORTS = new Set([137, 139]);
const AGGRESSIVE_HINT_PORTS = [80, 443, 22, 445, 5985, 1883, 5000, 8080];
const UNKNOWN_SERVICE_NAMES = new Set(["", "unknown", "tcpwrapped", "generic"]);

const isUnknownServiceName = (name: string | undefined): boolean =>
  !name || UNKNOWN_SERVICE_NAMES.has(name.trim().toLowerCase());

const updateService = (
  services: ServiceFingerprint[],
  port: number,
  updater: (service: ServiceFingerprint) => ServiceFingerprint,
  options?: { transport?: "tcp" | "udp"; secure?: boolean; name?: string },
): void => {
  const idx = services.findIndex((service) =>
    service.port === port && (!options?.transport || service.transport === options.transport));
  if (idx !== -1) {
    services[idx] = updater(services[idx]);
    return;
  }

  const created = updater({
    id: randomUUID(),
    port,
    transport: options?.transport ?? "tcp",
    name: options?.name ?? "unknown",
    secure: options?.secure ?? false,
    lastSeenAt: new Date().toISOString(),
  });
  services.push(created);
};

const parseSshBannerProductVersion = (banner: string): { product?: string; version?: string } => {
  const openssh = banner.match(/OpenSSH[_/ -]?([\d.p]+)/i);
  if (openssh) {
    return { product: "OpenSSH", version: openssh[1] };
  }
  const dropbear = banner.match(/Dropbear[_/ -]?([\d.]+)/i);
  if (dropbear) {
    return { product: "Dropbear SSH", version: dropbear[1] };
  }
  return {};
};

const parseHttpServerProductVersion = (serverHeader: string): { product?: string; version?: string } => {
  const trimmed = serverHeader.trim();
  if (!trimmed) return {};

  const slashVersion = trimmed.match(/^([A-Za-z][A-Za-z0-9._ -]{1,40})\/([0-9][A-Za-z0-9._-]{0,30})/);
  if (slashVersion) {
    return {
      product: slashVersion[1]?.trim(),
      version: slashVersion[2]?.trim(),
    };
  }

  const iis = trimmed.match(/microsoft-iis\/([0-9.]+)/i);
  if (iis) {
    return { product: "Microsoft IIS", version: iis[1] };
  }

  const token = trimmed.split(/\s+/)[0];
  return token ? { product: token } : {};
};

interface ProtocolHint {
  port: number;
  protocol: string;
  confidence: number;
  secure: boolean;
  evidence: string;
  banner?: string;
}

const shouldProbeUnknownService = (service: ServiceFingerprint): boolean => {
  return isUnknownServiceName(service.name);
};

const applyProtocolHintToService = (
  service: ServiceFingerprint,
  hint: ProtocolHint,
): ServiceFingerprint => {
  const shouldOverrideName = shouldProbeUnknownService(service);
  const hintedProduct = hint.protocol === "https"
    ? "HTTPS service"
    : hint.protocol === "http"
      ? "HTTP service"
      : hint.protocol === "ssh"
        ? "SSH service"
        : hint.protocol === "mqtt"
          ? "MQTT broker"
          : undefined;
  return {
    ...service,
    name: shouldOverrideName ? hint.protocol : service.name,
    secure: service.secure || hint.secure,
    banner: service.banner ?? hint.banner,
    product: service.product ?? hintedProduct,
  };
};

const probeUnknownServiceHint = async (
  ip: string,
  service: ServiceFingerprint,
  timeoutMs: number,
): Promise<ProtocolHint | undefined> => {
  const tunedTimeout = Math.min(1_500, timeoutMs);
  const banner = await grabTcpBanner(ip, service.port, tunedTimeout);
  if (banner) {
    if (banner.startsWith("SSH-")) {
      return {
        port: service.port,
        protocol: "ssh",
        confidence: 0.92,
        secure: true,
        evidence: "ssh_banner",
        banner: banner.slice(0, 120),
      };
    }
    if (/^HTTP\/1\./i.test(banner) || /^<!doctype html/i.test(banner)) {
      return {
        port: service.port,
        protocol: "http",
        confidence: 0.8,
        secure: false,
        evidence: "http_banner",
        banner: banner.slice(0, 120),
      };
    }
  }

  const httpInfo = await grabHttpInfo(ip, service.port, false, tunedTimeout);
  if (httpInfo?.serverHeader || httpInfo?.title) {
    return {
      port: service.port,
      protocol: "http",
      confidence: 0.82,
      secure: false,
      evidence: "http_banner",
      banner: httpInfo.serverHeader ?? httpInfo.title,
    };
  }

  const tlsCert = await grabTlsCert(ip, service.port, tunedTimeout);
  if (tlsCert) {
    return {
      port: service.port,
      protocol: "https",
      confidence: 0.85,
      secure: true,
      evidence: "tls_cert",
      banner: tlsCert.subject,
    };
  }

  const mqtt = await probeMqttBroker(ip, service.port, tunedTimeout);
  if (mqtt) {
    return {
      port: service.port,
      protocol: "mqtt",
      confidence: 0.9,
      secure: false,
      evidence: "mqtt_connack",
      banner: typeof mqtt.returnCode === "number" ? `connack:${mqtt.returnCode}` : undefined,
    };
  }

  return undefined;
};

export interface FingerprintResult {
  ip: string;
  services: ServiceFingerprint[];
  sshBanner?: string;
  snmpSysDescr?: string;
  snmpSysName?: string;
  inferredOs?: string;
  inferredProduct?: string;
  dnsService?: { port: number; answers: number; rcode: number };
  winrm?: { port: number; secure: boolean; statusCode?: number; server?: string; authHeader?: string };
  mqtt?: { port: number; returnCode?: number };
  smbDialect?: string;
  netbiosName?: string;
  protocolHints: ProtocolHint[];
  observations: DiscoveryObservationInput[];
}

export async function fingerprintDevice(
  candidate: DiscoveryCandidate,
  options?: { timeoutMs?: number; enableSnmp?: boolean; aggressive?: boolean },
): Promise<FingerprintResult> {
  const timeoutMs = options?.timeoutMs ?? 3000;
  const udpTimeoutMs = Math.min(timeoutMs, 1800);
  const enableSnmp = options?.enableSnmp ?? true;
  const aggressive = options?.aggressive ?? false;
  const ports = new Set(candidate.services.map((s) => s.port));
  const observedAt = new Date().toISOString();

  const enrichedServices = [...candidate.services];
  const observations: DiscoveryObservationInput[] = [];
  const protocolHints: ProtocolHint[] = [];
  let sshBanner: string | undefined;
  let snmpInfo: { sysDescr?: string; sysName?: string } = {};
  let primaryHttpInfo: HttpInfo | undefined;
  let primaryTlsCert: TlsCertInfo | undefined;
  let dnsService: FingerprintResult["dnsService"];
  let winrm: FingerprintResult["winrm"];
  let mqtt: FingerprintResult["mqtt"];
  let smbDialect: string | undefined;
  let netbiosName: string | undefined;

  // SSH banner grab
  const sshPort = [...SSH_PORTS].find((p) => ports.has(p));
  if (sshPort) {
    sshBanner = await grabSshBanner(candidate.ip, sshPort, timeoutMs);
    if (sshBanner) {
      const parsed = parseSshBannerProductVersion(sshBanner);
      updateService(enrichedServices, sshPort, (service) => ({
        ...service,
        name: isUnknownServiceName(service.name) ? "ssh" : service.name,
        secure: true,
        banner: sshBanner,
        product: service.product ?? parsed.product,
        version: service.version ?? parsed.version,
      }));
      observations.push(buildObservation({
        ip: candidate.ip,
        source: "fingerprint",
        evidenceType: "ssh_banner",
        confidence: 0.95,
        observedAt,
        ttlMs: 90 * 60_000,
        details: {
          port: sshPort,
          banner: sshBanner.slice(0, 160),
        },
      }));
    }
  }

  // TLS cert grab (up to two HTTPS ports)
  const tlsPorts = [...HTTPS_PORTS].filter((p) => ports.has(p)).slice(0, aggressive ? 3 : 2);
  for (const tlsPort of tlsPorts) {
    const cert = await grabTlsCert(candidate.ip, tlsPort, timeoutMs);
    if (!cert) {
      continue;
    }
    if (!primaryTlsCert) {
      primaryTlsCert = cert;
    }
    updateService(enrichedServices, tlsPort, (service) => ({
      ...service,
      secure: true,
      name: isUnknownServiceName(service.name) ? "https" : service.name,
      tlsCert: cert,
    }));
    observations.push(buildObservation({
      ip: candidate.ip,
      source: "fingerprint",
      evidenceType: "tls_cert",
      confidence: 0.82,
      observedAt,
      ttlMs: 24 * 60 * 60_000,
      details: {
        port: tlsPort,
        subject: cert.subject,
        issuer: cert.issuer,
        validTo: cert.validTo,
      },
    }));
  }

  // HTTP banner grab (prioritize HTTPS ports, then HTTP ports)
  const webProbeTargets = [
    ...[...HTTPS_PORTS].filter((p) => ports.has(p)).map((port) => ({ port, secure: true })),
    ...[...HTTP_PORTS].filter((p) => ports.has(p)).map((port) => ({ port, secure: false })),
  ].slice(0, aggressive ? 4 : 2);

  for (const { port, secure } of webProbeTargets) {
    const info = await grabHttpInfo(candidate.ip, port, secure, timeoutMs);
    if (!info) {
      continue;
    }
    if (!primaryHttpInfo) {
      primaryHttpInfo = info;
    }
    const parsedServer = info.serverHeader ? parseHttpServerProductVersion(info.serverHeader) : {};
    updateService(enrichedServices, port, (service) => ({
      ...service,
      name: isUnknownServiceName(service.name) ? (secure ? "https" : "http") : service.name,
      secure: service.secure || secure,
      httpInfo: info,
      banner: service.banner ?? info.serverHeader ?? info.title,
      product: service.product ?? parsedServer.product,
      version: service.version ?? parsedServer.version,
    }));

    if (info.serverHeader || info.title) {
      observations.push(buildObservation({
        ip: candidate.ip,
        source: "fingerprint",
        evidenceType: "http_banner",
        confidence: 0.8,
        observedAt,
        ttlMs: 90 * 60_000,
        details: {
          port,
          secure,
          serverHeader: info.serverHeader,
          title: info.title,
          poweredBy: info.poweredBy,
          generator: info.generator,
        },
      }));
    }
  }

  // SNMP probe (optionally opportunistic when aggressive mode is on)
  if (enableSnmp && (ports.has(161) || aggressive)) {
    snmpInfo = await grabSnmpInfo(candidate.ip, udpTimeoutMs);
    if (snmpInfo.sysDescr) {
      updateService(enrichedServices, 161, (service) => ({
        ...service,
        name: isUnknownServiceName(service.name) ? "snmp" : service.name,
        product: service.product ?? "SNMP agent",
      }), {
        transport: "udp",
        name: "snmp",
      });
      observations.push(buildObservation({
        ip: candidate.ip,
        source: "fingerprint",
        evidenceType: "snmp_sysdescr",
        confidence: 0.92,
        observedAt,
        ttlMs: 6 * 60 * 60_000,
        details: {
          sysDescr: snmpInfo.sysDescr.slice(0, 220),
          sysName: snmpInfo.sysName,
        },
      }));
    }
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

  // DNS service probe
  const dnsPort = [...DNS_PORTS].find((p) => ports.has(p)) ?? (aggressive ? 53 : undefined);
  if (dnsPort !== undefined) {
    const dnsProbe = await probeDnsService(candidate.ip, udpTimeoutMs);
    if (dnsProbe) {
      dnsService = { port: dnsPort, answers: dnsProbe.answers, rcode: dnsProbe.rcode };
      updateService(enrichedServices, dnsPort, (service) => ({
        ...service,
        name: isUnknownServiceName(service.name) ? "dns" : service.name,
        product: service.product ?? "DNS resolver",
      }), {
        transport: "udp",
        name: "dns",
      });
      observations.push(buildObservation({
        ip: candidate.ip,
        source: "fingerprint",
        evidenceType: "dns_service",
        confidence: 0.86,
        observedAt,
        ttlMs: 30 * 60_000,
        details: {
          port: dnsPort,
          answers: dnsProbe.answers,
          rcode: dnsProbe.rcode,
        },
      }));
    }
  }

  // WinRM endpoint probe
  for (const port of WINRM_PORTS) {
    if (!ports.has(port)) continue;
    const secure = port === 5986;
    const result = await probeWinRm(candidate.ip, port, secure, timeoutMs);
    if (!result) continue;
    winrm = {
      port,
      secure,
      statusCode: result.statusCode,
      server: result.server,
      authHeader: result.authHeader,
    };
    updateService(enrichedServices, port, (service) => ({
      ...service,
      name: isUnknownServiceName(service.name) ? "winrm" : service.name,
      secure: service.secure || secure,
      banner: service.banner ?? result.server ?? result.authHeader,
      product: service.product ?? "Windows Remote Management",
    }));
    observations.push(buildObservation({
      ip: candidate.ip,
      source: "fingerprint",
      evidenceType: "winrm_endpoint",
      confidence: 0.9,
      observedAt,
      ttlMs: 90 * 60_000,
      details: winrm,
    }));
    break;
  }

  // MQTT broker probe
  for (const port of MQTT_PORTS) {
    if (!ports.has(port)) continue;
    const result = await probeMqttBroker(candidate.ip, port, timeoutMs);
    if (!result) continue;
    mqtt = {
      port,
      returnCode: result.returnCode,
    };
    updateService(enrichedServices, port, (service) => ({
      ...service,
      name: isUnknownServiceName(service.name) ? "mqtt" : service.name,
      secure: service.secure || port === 8883,
      banner: service.banner ?? (typeof result.returnCode === "number" ? `connack:${result.returnCode}` : undefined),
      product: service.product ?? "MQTT broker",
    }));
    observations.push(buildObservation({
      ip: candidate.ip,
      source: "fingerprint",
      evidenceType: "mqtt_connack",
      confidence: 0.9,
      observedAt,
      ttlMs: 90 * 60_000,
      details: mqtt,
    }));
    break;
  }

  // SMB negotiate probe
  for (const port of SMB_PORTS) {
    if (!ports.has(port)) continue;
    const smb = await probeSmbNegotiate(candidate.ip, port, timeoutMs);
    if (!smb) continue;
    smbDialect = smb.dialect;
    updateService(enrichedServices, port, (service) => ({
      ...service,
      name: isUnknownServiceName(service.name) ? "smb" : service.name,
      banner: service.banner ?? smb.dialect,
      product: service.product ?? "SMB",
      version: service.version ?? smb.dialect,
    }));
    observations.push(buildObservation({
      ip: candidate.ip,
      source: "fingerprint",
      evidenceType: "smb_negotiate",
      confidence: 0.9,
      observedAt,
      ttlMs: 90 * 60_000,
      details: {
        port,
        dialect: smb.dialect,
      },
    }));
    break;
  }

  // NetBIOS name probe (opportunistic in aggressive mode)
  if ([...NETBIOS_PORTS].some((port) => ports.has(port)) || aggressive) {
    const nb = await probeNetbiosName(candidate.ip, udpTimeoutMs);
    if (nb) {
      netbiosName = nb.name;
      updateService(enrichedServices, 139, (service) => ({
        ...service,
        name: isUnknownServiceName(service.name) ? "netbios-ssn" : service.name,
        banner: service.banner ?? nb.name,
      }));
      observations.push(buildObservation({
        ip: candidate.ip,
        source: "fingerprint",
        evidenceType: "netbios_name",
        confidence: 0.78,
        observedAt,
        ttlMs: 6 * 60 * 60_000,
        details: {
          name: nb.name,
        },
      }));
    }
  }

  const recordProtocolHint = (hint: ProtocolHint): void => {
    protocolHints.push(hint);
    const idx = enrichedServices.findIndex((item) => item.port === hint.port && item.transport === "tcp");
    if (idx !== -1) {
      enrichedServices[idx] = applyProtocolHintToService(enrichedServices[idx], hint);
      return;
    }

    enrichedServices.push({
      id: randomUUID(),
      port: hint.port,
      transport: "tcp",
      name: hint.protocol,
      secure: hint.secure,
      banner: hint.banner,
      product: `${hint.protocol.toUpperCase()} service`,
      lastSeenAt: observedAt,
    });
  };

  // Lightweight protocol hints for unknown services
  const unknownServices = enrichedServices
    .filter(shouldProbeUnknownService)
    .slice(0, aggressive ? 10 : 4);
  for (const service of unknownServices) {
    const hint = await probeUnknownServiceHint(candidate.ip, service, timeoutMs);
    if (!hint) continue;
    recordProtocolHint(hint);
    observations.push(buildObservation({
      ip: candidate.ip,
      source: "fingerprint",
      evidenceType: "protocol_hint",
      confidence: hint.confidence,
      observedAt,
      ttlMs: 60 * 60_000,
      details: {
        port: hint.port,
        protocol: hint.protocol,
        secure: hint.secure,
        evidence: hint.evidence,
        banner: hint.banner,
      },
    }));
  }

  if (aggressive && enrichedServices.length === 0) {
    for (const port of AGGRESSIVE_HINT_PORTS) {
      const hint = await probeUnknownServiceHint(candidate.ip, {
        id: randomUUID(),
        port,
        transport: "tcp",
        name: "unknown",
        secure: port === 443 || port === 5001 || port === 8443 || port === 5986 || port === 8883,
        lastSeenAt: observedAt,
      }, Math.min(timeoutMs, 1200));
      if (!hint) {
        continue;
      }
      recordProtocolHint(hint);
      observations.push(buildObservation({
        ip: candidate.ip,
        source: "fingerprint",
        evidenceType: "protocol_hint",
        confidence: hint.confidence,
        observedAt,
        ttlMs: 60 * 60_000,
        details: {
          port: hint.port,
          protocol: hint.protocol,
          secure: hint.secure,
          evidence: hint.evidence,
          banner: hint.banner,
          mode: "aggressive-no-port",
        },
      }));
      if (enrichedServices.length >= 3) {
        break;
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
    dnsService,
    winrm,
    mqtt,
    smbDialect,
    netbiosName,
    protocolHints,
    observations: dedupeObservations(observations),
  };
}

export async function fingerprintBatch(
  candidates: DiscoveryCandidate[],
  options?: { maxConcurrency?: number; timeoutMs?: number; enableSnmp?: boolean; aggressive?: boolean },
): Promise<FingerprintResult[]> {
  const maxConcurrency = options?.maxConcurrency ?? 4;
  const results: FingerprintResult[] = [];

  for (let i = 0; i < candidates.length; i += maxConcurrency) {
    const batch = candidates.slice(i, i + maxConcurrency);
    const batchResults = await Promise.all(
      batch.map(async (candidate) => {
        try {
          return await fingerprintDevice(candidate, options);
        } catch (error) {
          console.warn(`[discovery] Fingerprint probe failed for ${candidate.ip}:`, error);
          return {
            ip: candidate.ip,
            services: candidate.services,
            protocolHints: [],
            observations: [],
          } satisfies FingerprintResult;
        }
      }),
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

    const existingFingerprint =
      (candidate.metadata.fingerprint as Record<string, unknown> | undefined) ?? {};
    const existingProtocolHints = Array.isArray(existingFingerprint.protocolHints)
      ? existingFingerprint.protocolHints as Array<Record<string, unknown>>
      : [];
    const mergedProtocolHints = Array.from(new Map(
      [...existingProtocolHints, ...fp.protocolHints]
        .map((hint) => {
          const port = Number((hint as Record<string, unknown>).port ?? -1);
          const protocol = String((hint as Record<string, unknown>).protocol ?? "");
          return [`${port}:${protocol}`, hint] as const;
        }),
    ).values());

    const inferredHostname =
      candidate.hostname ??
      fp.snmpSysName ??
      fp.netbiosName ??
      undefined;

    return {
      ...candidate,
      hostname: inferredHostname,
      os: candidate.os ?? fp.inferredOs,
      services: fp.services,
      observations: dedupeObservations([...(candidate.observations ?? []), ...fp.observations]),
      metadata: {
        ...candidate.metadata,
        fingerprint: {
          ...existingFingerprint,
          sshBanner: fp.sshBanner ?? existingFingerprint.sshBanner,
          snmpSysDescr: fp.snmpSysDescr ?? existingFingerprint.snmpSysDescr,
          snmpSysName: fp.snmpSysName ?? existingFingerprint.snmpSysName,
          inferredOs: fp.inferredOs ?? existingFingerprint.inferredOs,
          inferredProduct: fp.inferredProduct ?? existingFingerprint.inferredProduct,
          dnsService: fp.dnsService ?? existingFingerprint.dnsService,
          winrm: fp.winrm ?? existingFingerprint.winrm,
          mqtt: fp.mqtt ?? existingFingerprint.mqtt,
          smbDialect: fp.smbDialect ?? existingFingerprint.smbDialect,
          netbiosName: fp.netbiosName ?? existingFingerprint.netbiosName,
          protocolHints: mergedProtocolHints,
          lastFingerprintedAt: new Date().toISOString(),
          fingerprintVersion: CURRENT_FINGERPRINT_VERSION,
        },
      },
    };
  });
}
