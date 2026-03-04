import { randomUUID } from "node:crypto";
import type { DiscoveryCandidate } from "@/lib/discovery/types";
import { lookupOuiVendor } from "@/lib/discovery/oui";
import type { Device, DeviceType } from "@/lib/state/types";

/* ---------- Helpers ---------- */

const hasAny = (ports: number[], expected: number[]): boolean =>
  expected.some((port) => ports.includes(port));

const AUTO_NAME_PATTERN = /^(server|workstation|router|firewall|switch|access-point|camera|nas|printer|iot|container-host|hypervisor|unknown)-\d+-\d+-\d+-\d+$/;

const normalizeMac = (mac: string): string =>
  mac.toLowerCase().replace(/-/g, ":").trim();

const vendorSlug = (vendor: string): string =>
  vendor.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

/* ---------- Classification Signal System ---------- */

export interface ClassificationSignal {
  source: string;
  type: DeviceType;
  weight: number;
  reason: string;
}

export interface ClassificationResult {
  type: DeviceType;
  confidence: number;
  os?: string;
  signals: ClassificationSignal[];
}

/* ---------- Signal Collectors ---------- */

function signalsFromPorts(ports: number[], ip: string): ClassificationSignal[] {
  const signals: ClassificationSignal[] = [];

  if (hasAny(ports, [554, 8554])) {
    signals.push({ source: "port", type: "camera", weight: 65, reason: "RTSP port open" });
  }
  if (hasAny(ports, [9100, 631])) {
    signals.push({ source: "port", type: "printer", weight: 65, reason: "Printing port (JetDirect/IPP)" });
  }
  if (ports.includes(6443)) {
    signals.push({ source: "port", type: "hypervisor", weight: 60, reason: "Kubernetes API port" });
  }
  if (hasAny(ports, [902, 903, 9440])) {
    signals.push({ source: "port", type: "hypervisor", weight: 60, reason: "vSphere/Nutanix port" });
  }
  if (hasAny(ports, [2375, 2376])) {
    signals.push({ source: "port", type: "container-host", weight: 60, reason: "Docker API port" });
  }
  if (hasAny(ports, [5000, 5001])) {
    signals.push({ source: "port", type: "nas", weight: 45, reason: "NAS web interface port" });
  }
  if (ports.includes(2049)) {
    signals.push({ source: "port", type: "nas", weight: 55, reason: "NFS port" });
  }
  if (hasAny(ports, [161, 162])) {
    signals.push({ source: "port", type: "switch", weight: 40, reason: "SNMP port open" });
  }
  if (hasAny(ports, [500, 4500])) {
    signals.push({ source: "port", type: "firewall", weight: 50, reason: "IPSec/IKE ports" });
  }
  if (hasAny(ports, [8443, 10443]) && !hasAny(ports, [445, 3389])) {
    signals.push({ source: "port", type: "firewall", weight: 40, reason: "SSL VPN port" });
  }
  if (ip.endsWith(".1") && hasAny(ports, [53, 80, 443])) {
    signals.push({ source: "port", type: "router", weight: 35, reason: "Gateway IP with DNS/HTTP" });
  }
  if (ip.endsWith(".254") && hasAny(ports, [53, 80, 443])) {
    signals.push({ source: "port", type: "router", weight: 30, reason: "Common gateway IP with DNS/HTTP" });
  }
  if (hasAny(ports, [88, 389])) {
    signals.push({ source: "port", type: "server", weight: 55, reason: "Kerberos/LDAP (Active Directory)" });
  }
  if (hasAny(ports, [445, 3389]) && hasAny(ports, [5985, 5986])) {
    signals.push({ source: "port", type: "server", weight: 50, reason: "Windows management ports (SMB+WinRM)" });
  }
  if (ports.includes(3389) && !hasAny(ports, [88, 389, 5985])) {
    signals.push({ source: "port", type: "workstation", weight: 35, reason: "RDP without server ports" });
  }
  if (hasAny(ports, [1433, 1521, 3306, 5432, 6379, 27017])) {
    signals.push({ source: "port", type: "server", weight: 50, reason: "Database port open" });
  }
  if (hasAny(ports, [80, 443, 22]) && ports.length >= 4) {
    signals.push({ source: "port", type: "server", weight: 30, reason: "Multiple services including web/SSH" });
  }
  if (ports.includes(22) && ports.length < 3 && !hasAny(ports, [445, 3389])) {
    signals.push({ source: "port", type: "iot", weight: 25, reason: "SSH only with few ports" });
  }
  if (ports.includes(1883) || ports.includes(8883)) {
    signals.push({ source: "port", type: "iot", weight: 45, reason: "MQTT port open" });
  }

  return signals;
}

function signalsFromHostname(hostname: string | undefined): ClassificationSignal[] {
  if (!hostname) return [];
  const signals: ClassificationSignal[] = [];
  const h = hostname.toLowerCase();

  if (/^(iphone|ipad|macbook|imac|mac-?pro|mac-?mini)-?/.test(h)) {
    signals.push({ source: "hostname", type: "workstation", weight: 60, reason: `Apple device hostname: ${hostname}` });
  }
  if (/^(desktop|laptop|pc)-/i.test(h) || h.includes("workstation")) {
    signals.push({ source: "hostname", type: "workstation", weight: 55, reason: "Workstation hostname pattern" });
  }
  if (/^(win-|desktop-)[a-z0-9]+$/i.test(h)) {
    signals.push({ source: "hostname", type: "workstation", weight: 55, reason: "Windows default hostname" });
  }
  if (/(synology|diskstation|ds\d{3,4})/i.test(h)) {
    signals.push({ source: "hostname", type: "nas", weight: 70, reason: "Synology NAS hostname" });
  }
  if (/(qnap|ts-?\d{3,4})/i.test(h)) {
    signals.push({ source: "hostname", type: "nas", weight: 70, reason: "QNAP NAS hostname" });
  }
  if (/(camera|cam-|hikvision|reolink|axis|dahua|amcrest)/i.test(h)) {
    signals.push({ source: "hostname", type: "camera", weight: 65, reason: "Camera hostname pattern" });
  }
  if (/(switch|sw-|usw[\w-]*)/i.test(h)) {
    signals.push({ source: "hostname", type: "switch", weight: 60, reason: "Switch hostname pattern" });
  }
  if (/(access-?point|wifi|ap-|uap[\w-]*)/i.test(h)) {
    signals.push({ source: "hostname", type: "access-point", weight: 60, reason: "Access point hostname" });
  }
  if (/(router|gateway|gw-|ubnt|edgerouter|mikrotik)/i.test(h)) {
    signals.push({ source: "hostname", type: "router", weight: 60, reason: "Router hostname pattern" });
  }
  if (/(firewall|fw-|fortigate|pfsense|opnsense|paloalto)/i.test(h)) {
    signals.push({ source: "hostname", type: "firewall", weight: 65, reason: "Firewall hostname pattern" });
  }
  if (/(printer|prn-|brother|canon|epson|xerox|hp-?laserjet|hp-?officejet)/i.test(h)) {
    signals.push({ source: "hostname", type: "printer", weight: 65, reason: "Printer hostname pattern" });
  }
  if (/(esxi|vcenter|proxmox|hyperv|hyper-v)/i.test(h)) {
    signals.push({ source: "hostname", type: "hypervisor", weight: 65, reason: "Hypervisor hostname" });
  }
  if (/(docker|k8s|kube|rancher|container)/i.test(h)) {
    signals.push({ source: "hostname", type: "container-host", weight: 55, reason: "Container host hostname" });
  }
  if (/(nas|storage|backup|nfs)/i.test(h)) {
    signals.push({ source: "hostname", type: "nas", weight: 45, reason: "Storage-related hostname" });
  }
  if (/(srv|server|dc-|ad-|sql|db-|web-|app-|api-)/i.test(h)) {
    signals.push({ source: "hostname", type: "server", weight: 40, reason: "Server hostname pattern" });
  }

  return signals;
}

function signalsFromVendor(vendor: string | undefined, ports: number[]): ClassificationSignal[] {
  if (!vendor) return [];
  const signals: ClassificationSignal[] = [];
  const v = vendor.toLowerCase();

  if (v.includes("ubiquiti") || v.includes("ui.com")) {
    if (hasAny(ports, [161])) {
      signals.push({ source: "oui", type: "switch", weight: 55, reason: "Ubiquiti with SNMP" });
    } else {
      signals.push({ source: "oui", type: "access-point", weight: 45, reason: "Ubiquiti device" });
    }
  }
  if (v.includes("vmware")) {
    signals.push({ source: "oui", type: "hypervisor", weight: 65, reason: "VMware virtual MAC" });
  }
  if (v.includes("microsoft") && v.includes("hyper")) {
    signals.push({ source: "oui", type: "hypervisor", weight: 65, reason: "Hyper-V virtual MAC" });
  }
  if (v.includes("xen") || v.includes("citrix")) {
    signals.push({ source: "oui", type: "hypervisor", weight: 65, reason: "Xen virtual MAC" });
  }
  if (v.includes("oracle") && v.includes("virtualbox")) {
    signals.push({ source: "oui", type: "hypervisor", weight: 60, reason: "VirtualBox virtual MAC" });
  }
  if (v.includes("parallels")) {
    signals.push({ source: "oui", type: "hypervisor", weight: 60, reason: "Parallels virtual MAC" });
  }
  if (v.includes("raspberry pi")) {
    signals.push({ source: "oui", type: "iot", weight: 45, reason: "Raspberry Pi Foundation" });
  }
  if (v.includes("espressif")) {
    signals.push({ source: "oui", type: "iot", weight: 55, reason: "ESP32/ESP8266 IoT chip" });
  }
  if (v.includes("tuya") || v.includes("shelly") || v.includes("signify") || v.includes("philips")) {
    signals.push({ source: "oui", type: "iot", weight: 55, reason: `Smart home vendor: ${vendor}` });
  }
  if (v.includes("sonos") || v.includes("bose")) {
    signals.push({ source: "oui", type: "iot", weight: 55, reason: `Audio device vendor: ${vendor}` });
  }
  if (v.includes("roku")) {
    signals.push({ source: "oui", type: "iot", weight: 60, reason: "Roku media device" });
  }
  if (v.includes("ring") || (v.includes("amazon") && !v.includes("web services"))) {
    signals.push({ source: "oui", type: "iot", weight: 35, reason: "Amazon/Ring vendor" });
  }
  if (v.includes("cisco") || v.includes("meraki")) {
    signals.push({ source: "oui", type: "switch", weight: 40, reason: "Cisco/Meraki network vendor" });
  }
  if (v.includes("mikrotik")) {
    signals.push({ source: "oui", type: "router", weight: 50, reason: "MikroTik device" });
  }
  if (v.includes("fortinet")) {
    signals.push({ source: "oui", type: "firewall", weight: 55, reason: "Fortinet device" });
  }
  if (v.includes("palo alto")) {
    signals.push({ source: "oui", type: "firewall", weight: 55, reason: "Palo Alto device" });
  }
  if (v.includes("aruba") || v.includes("ruckus") || v.includes("cambium")) {
    signals.push({ source: "oui", type: "access-point", weight: 45, reason: `Wireless vendor: ${vendor}` });
  }
  if (v.includes("hikvision") || v.includes("dahua") || v.includes("axis") || v.includes("reolink") || v.includes("amcrest") || v.includes("hanwha") || v.includes("vivotek")) {
    signals.push({ source: "oui", type: "camera", weight: 70, reason: `Camera vendor: ${vendor}` });
  }
  if (v.includes("synology")) {
    signals.push({ source: "oui", type: "nas", weight: 70, reason: "Synology NAS vendor" });
  }
  if (v.includes("qnap")) {
    signals.push({ source: "oui", type: "nas", weight: 70, reason: "QNAP NAS vendor" });
  }
  if (v.includes("brother") || v.includes("canon") || v.includes("epson") || v.includes("xerox") || v.includes("lexmark") || v.includes("ricoh") || v.includes("konica")) {
    signals.push({ source: "oui", type: "printer", weight: 65, reason: `Printer vendor: ${vendor}` });
  }

  return signals;
}

function signalsFromSnmp(metadata: Record<string, unknown>): ClassificationSignal[] {
  const fp = metadata.fingerprint as Record<string, unknown> | undefined;
  const sysDescr = (fp?.snmpSysDescr as string) ?? undefined;
  if (!sysDescr) return [];

  const signals: ClassificationSignal[] = [];
  const lower = sysDescr.toLowerCase();

  if (lower.includes("cisco ios")) {
    if (lower.includes("switch") || /c2960|c3750|c9300|catalyst/i.test(sysDescr)) {
      signals.push({ source: "snmp", type: "switch", weight: 95, reason: `Cisco switch: ${sysDescr.slice(0, 80)}` });
    } else if (/asr|isr|c1900|c2900|c3900/i.test(sysDescr)) {
      signals.push({ source: "snmp", type: "router", weight: 95, reason: `Cisco router: ${sysDescr.slice(0, 80)}` });
    } else {
      signals.push({ source: "snmp", type: "switch", weight: 85, reason: "Cisco IOS device" });
    }
  }
  if (lower.includes("junos")) {
    signals.push({ source: "snmp", type: lower.includes("switch") ? "switch" : "router", weight: 90, reason: "Juniper device" });
  }
  if (lower.includes("fortios") || lower.includes("fortigate")) {
    signals.push({ source: "snmp", type: "firewall", weight: 95, reason: "FortiGate firewall" });
  }
  if (lower.includes("panos") || lower.includes("palo alto")) {
    signals.push({ source: "snmp", type: "firewall", weight: 95, reason: "Palo Alto firewall" });
  }
  if (lower.includes("synology")) {
    signals.push({ source: "snmp", type: "nas", weight: 95, reason: `Synology: ${sysDescr.slice(0, 80)}` });
  }
  if (lower.includes("qnap")) {
    signals.push({ source: "snmp", type: "nas", weight: 95, reason: `QNAP: ${sysDescr.slice(0, 80)}` });
  }
  if (lower.includes("printer") || lower.includes("laserjet") || lower.includes("officejet") || lower.includes("deskjet")) {
    signals.push({ source: "snmp", type: "printer", weight: 90, reason: "Printer via SNMP" });
  }
  if (lower.includes("esxi") || lower.includes("vmware")) {
    signals.push({ source: "snmp", type: "hypervisor", weight: 90, reason: "VMware ESXi via SNMP" });
  }
  if (lower.includes("routeros") || lower.includes("mikrotik")) {
    signals.push({ source: "snmp", type: "router", weight: 90, reason: "MikroTik via SNMP" });
  }
  if (lower.includes("linux") && signals.length === 0) {
    signals.push({ source: "snmp", type: "server", weight: 40, reason: "Linux system via SNMP" });
  }
  if (lower.includes("windows") && signals.length === 0) {
    signals.push({ source: "snmp", type: "server", weight: 40, reason: "Windows system via SNMP" });
  }

  return signals;
}

function signalsFromBanners(metadata: Record<string, unknown>): ClassificationSignal[] {
  const fp = metadata.fingerprint as Record<string, unknown> | undefined;
  if (!fp) return [];
  const signals: ClassificationSignal[] = [];

  const sshBanner = fp.sshBanner as string | undefined;
  if (sshBanner) {
    const lower = sshBanner.toLowerCase();
    if (lower.includes("dropbear")) {
      signals.push({ source: "banner", type: "iot", weight: 40, reason: "Dropbear SSH (embedded device)" });
    }
    if (lower.includes("ubuntu") || lower.includes("debian") || /el[6-9]/.test(lower)) {
      signals.push({ source: "banner", type: "server", weight: 35, reason: `Server-class Linux: ${sshBanner.slice(0, 60)}` });
    }
  }

  const product = fp.inferredProduct as string | undefined;
  if (product) {
    const lower = product.toLowerCase();
    if (lower.includes("synology")) signals.push({ source: "banner", type: "nas", weight: 80, reason: `Product: ${product}` });
    if (lower.includes("qnap")) signals.push({ source: "banner", type: "nas", weight: 80, reason: `Product: ${product}` });
    if (lower.includes("truenas") || lower.includes("freenas")) signals.push({ source: "banner", type: "nas", weight: 80, reason: `Product: ${product}` });
    if (lower.includes("unifi")) signals.push({ source: "banner", type: "switch", weight: 70, reason: `Product: ${product}` });
    if (lower.includes("proxmox")) signals.push({ source: "banner", type: "hypervisor", weight: 80, reason: `Product: ${product}` });
    if (lower.includes("pfsense") || lower.includes("opnsense")) signals.push({ source: "banner", type: "firewall", weight: 80, reason: `Product: ${product}` });
    if (lower.includes("pi-hole")) signals.push({ source: "banner", type: "server", weight: 50, reason: `Product: ${product}` });
    if (lower.includes("home assistant")) signals.push({ source: "banner", type: "iot", weight: 50, reason: `Product: ${product}` });
    if (lower.includes("idrac") || lower.includes("ilo") || lower.includes("ipmi")) {
      signals.push({ source: "banner", type: "server", weight: 70, reason: `BMC/Management: ${product}` });
    }
    if (lower.includes("grafana") || lower.includes("jenkins") || lower.includes("gitlab") || lower.includes("nextcloud")) {
      signals.push({ source: "banner", type: "server", weight: 55, reason: `Server application: ${product}` });
    }
  }

  return signals;
}

function signalsFromHttpServices(services: Array<{ port: number; httpInfo?: { serverHeader?: string; title?: string; poweredBy?: string } }>): ClassificationSignal[] {
  const signals: ClassificationSignal[] = [];

  for (const svc of services) {
    const httpInfo = svc.httpInfo;
    if (!httpInfo) continue;

    if (httpInfo.serverHeader) {
      const s = httpInfo.serverHeader.toLowerCase();
      if (s.includes("microsoft-iis")) signals.push({ source: "http", type: "server", weight: 60, reason: "IIS web server" });
      if (s.includes("synology")) signals.push({ source: "http", type: "nas", weight: 80, reason: "Synology HTTP" });
      if (s.includes("mini-httpd") || s.includes("lighttpd") || s.includes("boa")) {
        signals.push({ source: "http", type: "iot", weight: 35, reason: "Embedded web server" });
      }
    }

    if (httpInfo.title) {
      const t = httpInfo.title.toLowerCase();
      if (t.includes("printer") || t.includes("laserjet") || t.includes("officejet")) {
        signals.push({ source: "http", type: "printer", weight: 75, reason: `Printer web UI: ${httpInfo.title.slice(0, 60)}` });
      }
      if (t.includes("nas") || t.includes("synology") || t.includes("qnap")) {
        signals.push({ source: "http", type: "nas", weight: 75, reason: `NAS web UI: ${httpInfo.title.slice(0, 60)}` });
      }
      if (t.includes("camera") || t.includes("surveillance") || t.includes("dvr") || t.includes("nvr")) {
        signals.push({ source: "http", type: "camera", weight: 70, reason: `Camera web UI: ${httpInfo.title.slice(0, 60)}` });
      }
      if (t.includes("router") || t.includes("gateway")) {
        signals.push({ source: "http", type: "router", weight: 60, reason: `Router web UI: ${httpInfo.title.slice(0, 60)}` });
      }
      if (t.includes("firewall")) {
        signals.push({ source: "http", type: "firewall", weight: 65, reason: `Firewall web UI: ${httpInfo.title.slice(0, 60)}` });
      }
      if (t.includes("switch") || t.includes("managed switch")) {
        signals.push({ source: "http", type: "switch", weight: 65, reason: `Switch web UI: ${httpInfo.title.slice(0, 60)}` });
      }
    }
  }

  return signals;
}

function signalsFromTlsServices(services: Array<{ port: number; tlsCert?: { subject: string; sans: string[] } }>): ClassificationSignal[] {
  const signals: ClassificationSignal[] = [];

  for (const svc of services) {
    const cert = svc.tlsCert;
    if (!cert) continue;

    const combined = [cert.subject, ...cert.sans].join(" ").toLowerCase();
    if (combined.includes("unifi")) signals.push({ source: "tls", type: "switch", weight: 70, reason: "UniFi TLS cert" });
    if (combined.includes("synology")) signals.push({ source: "tls", type: "nas", weight: 70, reason: "Synology TLS cert" });
    if (combined.includes("qnap")) signals.push({ source: "tls", type: "nas", weight: 70, reason: "QNAP TLS cert" });
    if (combined.includes("idrac")) signals.push({ source: "tls", type: "server", weight: 65, reason: "Dell iDRAC TLS cert" });
    if (combined.includes("ilo")) signals.push({ source: "tls", type: "server", weight: 65, reason: "HPE iLO TLS cert" });
    if (combined.includes("fortigate")) signals.push({ source: "tls", type: "firewall", weight: 75, reason: "FortiGate TLS cert" });
    if (combined.includes("paloalto")) signals.push({ source: "tls", type: "firewall", weight: 75, reason: "Palo Alto TLS cert" });
    if (combined.includes("esxi") || combined.includes("vmware")) signals.push({ source: "tls", type: "hypervisor", weight: 70, reason: "VMware TLS cert" });
    if (combined.includes("proxmox")) signals.push({ source: "tls", type: "hypervisor", weight: 70, reason: "Proxmox TLS cert" });
  }

  return signals;
}

function signalsFromMdns(metadata: Record<string, unknown>): ClassificationSignal[] {
  const mdnsServices = metadata.mdnsServices as string[] | undefined;
  if (!mdnsServices || mdnsServices.length === 0) return [];

  const signals: ClassificationSignal[] = [];
  const MDNS_MAP: Record<string, { type: DeviceType; weight: number; reason: string }> = {
    "_airplay._tcp": { type: "iot", weight: 65, reason: "AirPlay device (mDNS)" },
    "_raop._tcp": { type: "iot", weight: 60, reason: "AirPlay audio (mDNS)" },
    "_googlecast._tcp": { type: "iot", weight: 65, reason: "Chromecast (mDNS)" },
    "_sonos._tcp": { type: "iot", weight: 70, reason: "Sonos speaker (mDNS)" },
    "_ipp._tcp": { type: "printer", weight: 75, reason: "IPP printer (mDNS)" },
    "_ipps._tcp": { type: "printer", weight: 75, reason: "IPP printer secure (mDNS)" },
    "_printer._tcp": { type: "printer", weight: 75, reason: "Printer (mDNS)" },
    "_pdl-datastream._tcp": { type: "printer", weight: 70, reason: "PDL printer (mDNS)" },
    "_scanner._tcp": { type: "printer", weight: 60, reason: "Scanner (mDNS)" },
    "_smb._tcp": { type: "nas", weight: 50, reason: "SMB file share (mDNS)" },
    "_afpovertcp._tcp": { type: "nas", weight: 50, reason: "AFP file share (mDNS)" },
    "_nfs._tcp": { type: "nas", weight: 55, reason: "NFS (mDNS)" },
    "_homekit._tcp": { type: "iot", weight: 60, reason: "HomeKit device (mDNS)" },
    "_hap._tcp": { type: "iot", weight: 60, reason: "HomeKit accessory (mDNS)" },
    "_hue._tcp": { type: "iot", weight: 65, reason: "Philips Hue (mDNS)" },
    "_rtsp._tcp": { type: "camera", weight: 70, reason: "RTSP camera (mDNS)" },
    "_companion-link._tcp": { type: "workstation", weight: 50, reason: "Apple Companion (mDNS)" },
    "_workstation._tcp": { type: "workstation", weight: 45, reason: "Workstation (mDNS)" },
    "_ssh._tcp": { type: "server", weight: 30, reason: "SSH service (mDNS)" },
    "_http._tcp": { type: "server", weight: 25, reason: "HTTP service (mDNS)" },
  };

  for (const svc of mdnsServices) {
    const mapping = MDNS_MAP[svc];
    if (mapping) {
      signals.push({ source: "mdns", ...mapping });
    }
  }

  return signals;
}

function signalsFromSsdp(metadata: Record<string, unknown>): ClassificationSignal[] {
  const signals: ClassificationSignal[] = [];
  const deviceType = metadata.ssdpDeviceType as string | undefined;
  const friendlyName = metadata.ssdpFriendlyName as string | undefined;
  const manufacturer = metadata.ssdpManufacturer as string | undefined;
  const modelName = metadata.ssdpModelName as string | undefined;

  if (deviceType) {
    const lower = deviceType.toLowerCase();
    if (lower.includes("mediaserver") || lower.includes("mediarenderer")) {
      signals.push({ source: "ssdp", type: "iot", weight: 60, reason: `UPnP media device: ${deviceType}` });
    }
    if (lower.includes("internetgateway") || lower.includes("wanconnection")) {
      signals.push({ source: "ssdp", type: "router", weight: 75, reason: `UPnP gateway: ${deviceType}` });
    }
    if (lower.includes("printer")) {
      signals.push({ source: "ssdp", type: "printer", weight: 70, reason: "UPnP printer" });
    }
  }

  if (friendlyName || manufacturer || modelName) {
    const combined = [friendlyName, manufacturer, modelName].filter(Boolean).join(" ").toLowerCase();
    if (combined.includes("roku")) signals.push({ source: "ssdp", type: "iot", weight: 65, reason: "Roku via SSDP" });
    if (combined.includes("chromecast") || combined.includes("google tv")) signals.push({ source: "ssdp", type: "iot", weight: 65, reason: "Chromecast via SSDP" });
    if (combined.includes("samsung tv") || combined.includes("lg tv") || combined.includes("sony tv")) {
      signals.push({ source: "ssdp", type: "iot", weight: 65, reason: "Smart TV via SSDP" });
    }
    if (combined.includes("sonos")) signals.push({ source: "ssdp", type: "iot", weight: 70, reason: "Sonos via SSDP" });
    if (combined.includes("xbox") || combined.includes("playstation")) {
      signals.push({ source: "ssdp", type: "iot", weight: 55, reason: "Gaming console via SSDP" });
    }
  }

  return signals;
}

/* ---------- Scoring Engine ---------- */

export function classifyDevice(candidate: DiscoveryCandidate): ClassificationResult {
  const ports = candidate.services.map((s) => s.port);
  const signals: ClassificationSignal[] = [];

  signals.push(...signalsFromPorts(ports, candidate.ip));
  signals.push(...signalsFromHostname(candidate.hostname));
  signals.push(...signalsFromVendor(candidate.vendor, ports));
  signals.push(...signalsFromSnmp(candidate.metadata));
  signals.push(...signalsFromBanners(candidate.metadata));
  signals.push(...signalsFromHttpServices(candidate.services as never));
  signals.push(...signalsFromTlsServices(candidate.services as never));
  signals.push(...signalsFromMdns(candidate.metadata));
  signals.push(...signalsFromSsdp(candidate.metadata));

  // Score each device type
  const scores = new Map<DeviceType, number>();
  for (const signal of signals) {
    scores.set(signal.type, (scores.get(signal.type) ?? 0) + signal.weight);
  }

  const sorted = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const [bestType, bestScore] = sorted[0] ?? ["unknown" as DeviceType, 0];
  const maxPossible = Math.max(150, signals.reduce((sum, s) => sum + s.weight, 0) * 0.5);
  const confidence = Math.min(1, bestScore / maxPossible);

  // OS detection from fingerprint data and ports
  const fp = candidate.metadata.fingerprint as Record<string, unknown> | undefined;
  let os: string | undefined;
  if (fp?.inferredOs) {
    os = fp.inferredOs as string;
  } else if (fp?.sshBanner) {
    const lower = (fp.sshBanner as string).toLowerCase();
    if (lower.includes("ubuntu")) os = "Ubuntu";
    else if (lower.includes("debian")) os = "Debian";
    else if (/el[6-9]|centos|rhel/.test(lower)) os = "RHEL/CentOS";
  }
  if (!os) {
    if (hasAny(ports, [5985, 5986]) || (ports.includes(445) && ports.includes(3389))) {
      os = "Windows";
    } else if (ports.includes(22) && !hasAny(ports, [445, 3389])) {
      os = "Linux/Unix";
    }
  }

  return { type: bestType, confidence, os, signals };
}

/* ---------- Protocol Inference ---------- */

const inferProtocols = (ports: number[]): string[] => {
  const protocols = new Set<string>();
  if (ports.includes(22)) protocols.add("ssh");
  if (ports.includes(3389) || ports.includes(5985) || ports.includes(5986)) protocols.add("winrm");
  if (ports.includes(161)) protocols.add("snmp");
  if (ports.includes(443) || ports.includes(80)) protocols.add("http-api");
  if (ports.includes(2375) || ports.includes(2376)) protocols.add("docker");
  if (ports.includes(6443)) protocols.add("kubernetes");
  if (ports.includes(1883)) protocols.add("mqtt");
  if (ports.includes(3389) || ports.includes(445) || ports.includes(389)) protocols.add("windows");
  if (ports.includes(554)) protocols.add("rtsp");
  if (ports.includes(53)) protocols.add("dns");
  if (ports.includes(631) || ports.includes(9100)) protocols.add("printing");
  return Array.from(protocols);
};

/* ---------- MAC-Based Deduplication ---------- */

function selectPrimaryIp(candidates: DiscoveryCandidate[]): DiscoveryCandidate {
  return candidates.sort((a, b) => {
    const diff = b.services.length - a.services.length;
    if (diff !== 0) return diff;
    return a.ip.localeCompare(b.ip);
  })[0]!;
}

function mergeGroup(group: DiscoveryCandidate[], primaryIp: string): DiscoveryCandidate {
  const primary = group.find((c) => c.ip === primaryIp)!;
  const allServices = new Map<string, (typeof primary.services)[number]>();

  for (const candidate of group) {
    for (const service of candidate.services) {
      const key = `${service.transport}:${service.port}`;
      if (!allServices.has(key)) {
        allServices.set(key, service);
      }
    }
  }

  return {
    ...primary,
    ip: primaryIp,
    mac: primary.mac ?? group.find((c) => c.mac)?.mac,
    hostname: primary.hostname ?? group.find((c) => c.hostname)?.hostname,
    vendor: primary.vendor ?? group.find((c) => c.vendor)?.vendor,
    os: primary.os ?? group.find((c) => c.os)?.os,
    typeHint: primary.typeHint ?? group.find((c) => c.typeHint)?.typeHint,
    services: Array.from(allServices.values()).sort((a, b) => a.port - b.port),
    metadata: {
      ...Object.assign({}, ...group.map((c) => c.metadata)),
      secondaryIps: group.map((c) => c.ip).filter((ip) => ip !== primaryIp),
    },
  };
}

export const mergeDiscoveryCandidates = (
  candidates: DiscoveryCandidate[],
): DiscoveryCandidate[] => {
  // Pass 1: Group by MAC address (same physical device, possibly different IPs)
  const byMac = new Map<string, DiscoveryCandidate[]>();
  const noMac: DiscoveryCandidate[] = [];

  for (const candidate of candidates) {
    if (candidate.mac) {
      const normalized = normalizeMac(candidate.mac);
      const group = byMac.get(normalized) ?? [];
      group.push(candidate);
      byMac.set(normalized, group);
    } else {
      noMac.push(candidate);
    }
  }

  // Pass 2: For each MAC group, merge into a single candidate with primary IP
  const macMerged: DiscoveryCandidate[] = [];
  for (const [, group] of byMac) {
    const primary = selectPrimaryIp(group);
    macMerged.push(mergeGroup(group, primary.ip));
  }

  // Pass 3: Merge all candidates (MAC-merged + MAC-less) by IP
  const byIp = new Map<string, DiscoveryCandidate>();

  for (const candidate of [...macMerged, ...noMac]) {
    const existing = byIp.get(candidate.ip);
    if (!existing) {
      byIp.set(candidate.ip, candidate);
      continue;
    }

    byIp.set(candidate.ip, {
      ...existing,
      mac: existing.mac ?? candidate.mac,
      hostname: existing.hostname ?? candidate.hostname,
      vendor: existing.vendor ?? candidate.vendor,
      os: existing.os ?? candidate.os,
      typeHint: existing.typeHint ?? candidate.typeHint,
      services: [...existing.services, ...candidate.services],
      metadata: { ...existing.metadata, ...candidate.metadata },
      source: candidate.source,
    });
  }

  // Deduplicate services and apply OUI vendor lookup
  return Array.from(byIp.values()).map((candidate) => {
    const serviceByKey = new Map<string, (typeof candidate.services)[number]>();
    for (const service of candidate.services) {
      const key = `${service.transport}:${service.port}`;
      serviceByKey.set(key, service);
    }

    const vendor = candidate.vendor ?? lookupOuiVendor(candidate.mac);

    return {
      ...candidate,
      vendor,
      services: Array.from(serviceByKey.values()).sort((a, b) => a.port - b.port),
    };
  });
};

/* ---------- Candidate -> Device Conversion ---------- */

export const candidateToDevice = (
  candidate: DiscoveryCandidate,
  previous?: Device,
): Device => {
  const now = new Date().toISOString();
  const ports = candidate.services.map((service) => service.port);
  const protocols = inferProtocols(ports);

  const hostname = candidate.hostname ?? previous?.hostname;
  const vendor = candidate.vendor ?? previous?.vendor ?? lookupOuiVendor(candidate.mac ?? previous?.mac);

  // Run the scoring classification engine
  const enrichedCandidate: DiscoveryCandidate = { ...candidate, hostname, vendor };
  const classification = classifyDevice(enrichedCandidate);

  // Use typeHint override, scored classification, or preserve previous non-unknown type
  const finalType =
    candidate.typeHint ??
    (classification.type !== "unknown" ? classification.type : undefined) ??
    (previous?.type !== "unknown" ? previous?.type : undefined) ??
    classification.type;

  const shouldPreferHostnameName =
    Boolean(hostname) &&
    (!previous?.name || previous.name === previous.hostname || AUTO_NAME_PATTERN.test(previous.name));

  const generatedName = vendor
    ? `${vendorSlug(vendor)}-${finalType}-${candidate.ip.replaceAll(".", "-")}`
    : `${finalType}-${candidate.ip.replaceAll(".", "-")}`;

  const nextName = shouldPreferHostnameName
    ? (hostname as string)
    : (previous?.name ?? candidate.hostname ?? generatedName);

  // Use mDNS/SSDP friendly name if we have no better name
  const mdnsFriendlyName = candidate.metadata.mdnsFriendlyName as string | undefined;
  const ssdpFriendlyName = candidate.metadata.ssdpFriendlyName as string | undefined;
  const friendlyName = mdnsFriendlyName ?? ssdpFriendlyName;
  const displayName = (nextName === generatedName && friendlyName) ? friendlyName : nextName;

  const secondaryIps = (candidate.metadata.secondaryIps as string[] | undefined) ?? previous?.secondaryIps;

  return {
    id: previous?.id ?? randomUUID(),
    name: displayName,
    ip: candidate.ip,
    secondaryIps: secondaryIps && secondaryIps.length > 0 ? secondaryIps : undefined,
    mac: candidate.mac ?? previous?.mac,
    hostname,
    vendor,
    os: classification.os ?? candidate.os ?? previous?.os,
    role: previous?.role,
    type: finalType,
    status: "online",
    autonomyTier: previous?.autonomyTier ?? 1,
    tags: previous?.tags ?? [],
    protocols: Array.from(new Set([...(previous?.protocols ?? []), ...protocols])),
    services:
      candidate.services.length > 0
        ? candidate.services
        : (previous?.services ?? []).map((service) => ({ ...service, lastSeenAt: now })),
    firstSeenAt: previous?.firstSeenAt ?? now,
    lastSeenAt: now,
    lastChangedAt: now,
    metadata: {
      ...previous?.metadata,
      ...candidate.metadata,
      source: candidate.source,
      classification: {
        confidence: classification.confidence,
        signals: classification.signals.slice(0, 20).map((s) => ({
          source: s.source,
          type: s.type,
          weight: s.weight,
          reason: s.reason,
        })),
        classifiedAt: now,
      },
    },
  };
};
