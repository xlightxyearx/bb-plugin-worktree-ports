import type { ScannedPort } from "./contract";
import { serviceNameFor } from "./roles";

/** Ports in the 443 family are TLS often enough to be worth guessing. */
export function schemeFor(port: ScannedPort): "http" | "https" {
  if (port.scheme !== null) return port.scheme;
  return port.port === 443 || String(port.port).endsWith("443") ? "https" : "http";
}

export function urlFor(port: ScannedPort): string {
  return `${schemeFor(port)}://localhost:${port.port}`;
}

export function describe(port: ScannedPort): string {
  const source = port.container === null ? port.processName : `docker/${port.container}`;
  return port.label === null ? source : `${port.label} (${source})`;
}

/** The name on a pill: the label, the compose service, or the process. */
export function pillName(port: ScannedPort): string {
  if (port.label !== null) return port.label;
  if (port.source === "docker" || port.role === "service") return serviceNameFor(port);
  return port.processName;
}
