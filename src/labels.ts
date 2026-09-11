import type { ScannedPort } from "./contract";

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
