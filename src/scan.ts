// Pure parsing and attribution. Everything that touches the system lives in
// host.ts so this half stays unit-testable without spawning anything.
import { sep } from "node:path";
import type { PortRoot } from "./contract";

export interface Listener {
  pid: number;
  processName: string;
  address: string;
  port: number;
}

export interface PortLabel {
  label: string;
  scheme: "http" | "https" | null;
}

export interface DockerRow {
  id: string;
  name: string;
  workingDir: string;
  ports: { port: number; address: string }[];
}

/** `*:3000`, `127.0.0.1:3000`, `[::1]:3000`, `[::]:3000`. */
function parseAddressPort(
  value: string,
): { address: string; port: number } | null {
  const match = value.match(/^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/);
  if (match === null) return null;
  const port = Number.parseInt(match[3] as string, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const host = match[1] ?? match[2] ?? "*";
  return { address: host === "*" ? "0.0.0.0" : host, port };
}

/**
 * Columnar `lsof -nP -iTCP -sTCP:LISTEN` output. lsof escapes spaces in the
 * COMMAND column as `\x20`, so splitting on whitespace is safe.
 */
export function parseListeners(output: string): Listener[] {
  const listeners: Listener[] = [];
  for (const line of output.split("\n").slice(1)) {
    if (line.trim() === "") continue;
    const columns = line.split(/\s+/);
    if (columns.length < 9) continue;
    const processName = columns[0] as string;
    const pid = Number.parseInt(columns[1] as string, 10);
    // NAME sits before the trailing "(LISTEN)" state.
    const name = columns[columns.length - 2] as string;
    if (!Number.isInteger(pid)) continue;
    const parsed = parseAddressPort(name);
    if (parsed === null) continue;
    listeners.push({ pid, processName, ...parsed });
  }
  return listeners;
}

/** Field-mode `lsof -a -p <pids> -d cwd -Fn` output: `p<pid>`, `fcwd`, `n<path>`. */
export function parseCwds(output: string): Map<number, string> {
  const cwds = new Map<number, string>();
  let pid: number | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) {
      const parsed = Number.parseInt(line.slice(1), 10);
      pid = Number.isInteger(parsed) ? parsed : null;
    } else if (line.startsWith("n") && pid !== null && !cwds.has(pid)) {
      cwds.set(pid, line.slice(1));
    }
  }
  return cwds;
}

/** `docker ps` rows formatted as id \t name \t ports \t compose working dir. */
export function parseDockerRows(output: string): DockerRow[] {
  const rows: DockerRow[] = [];
  for (const line of output.split("\n")) {
    if (line.trim() === "") continue;
    const [id, name, ports, workingDir] = line.split("\t");
    if (id === undefined || name === undefined || workingDir === undefined) continue;
    if (workingDir.trim() === "") continue;
    rows.push({
      id,
      name,
      workingDir: workingDir.trim(),
      ports: parseDockerPorts(ports ?? ""),
    });
  }
  return rows;
}

/**
 * `0.0.0.0:21785->6379/tcp, [::]:21785->6379/tcp` — only published mappings
 * (those with `->`) reach the host, and the IPv4/IPv6 pair is one port.
 */
export function parseDockerPorts(value: string): { port: number; address: string }[] {
  const seen = new Map<number, string>();
  for (const entry of value.split(",")) {
    const arrow = entry.indexOf("->");
    if (arrow === -1) continue;
    const published = entry.slice(0, arrow).trim();
    const parsed = parseAddressPort(published);
    if (parsed === null) continue;
    // Prefer the IPv4 binding when a port is published on both families.
    if (!seen.has(parsed.port) || parsed.address.includes(".")) {
      seen.set(parsed.port, parsed.address);
    }
  }
  return [...seen].map(([port, address]) => ({ port, address }));
}

/**
 * The worktree owning a path — longest match wins, so a chain worktree nested
 * under another root is attributed to itself rather than its parent.
 */
export function attribute(path: string, roots: PortRoot[]): string | null {
  let best: PortRoot | null = null;
  for (const root of roots) {
    if (path !== root.path && !path.startsWith(root.path.replace(/\/+$/, "") + sep)) {
      continue;
    }
    if (best === null || root.path.length > best.path.length) best = root;
  }
  return best === null ? null : best.environmentId;
}

/**
 * A worktree's ports.json. Discovery stays authoritative: this only names
 * ports that are already listening, and a malformed file labels nothing.
 */
export function parseLabels(content: string): Map<number, PortLabel> {
  const labels = new Map<number, PortLabel>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return labels;
  }
  const entries = (parsed as { ports?: unknown })?.ports;
  if (!Array.isArray(entries)) return labels;
  for (const entry of entries) {
    const port = (entry as { port?: unknown })?.port;
    const label = (entry as { label?: unknown })?.label;
    if (typeof port !== "number" || !Number.isInteger(port)) continue;
    if (port < 1 || port > 65535) continue;
    if (typeof label !== "string" || label.trim() === "") continue;
    const scheme = (entry as { scheme?: unknown })?.scheme;
    labels.set(port, {
      label: label.trim().slice(0, 80),
      scheme: scheme === "https" || scheme === "http" ? scheme : null,
    });
  }
  return labels;
}
