// Full-trust host entry: the only place that runs lsof/docker and reads a
// worktree's ports.json. One worker per enrolled machine, so a worktree on a
// remote host is scanned where it actually runs.
import { execFile } from "node:child_process";
import { readFile, readlink } from "node:fs/promises";
import { platform } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract, type PortRoot, type ScannedPort } from "./src/contract.js";
import { compareByRole, roleFor } from "./src/roles.js";
import {
  attribute,
  parseCwds,
  parseDockerRows,
  parseListeners,
  parseLabels,
  type Listener,
  type PortLabel,
} from "./src/scan.js";

const execFileAsync = promisify(execFile);
const EXEC_TIMEOUT_MS = 5_000;
const MAX_BUFFER = 8 * 1024 * 1024;
/** Every worktree ports.json read per scan, cheap enough to re-read each pass. */
const LABEL_FILES = [".bb/ports.json", ".superset/ports.json"];

/**
 * lsof exits non-zero when any file is inaccessible, which is routine on a
 * shared machine — partial stdout is still the answer we want.
 */
async function runTolerant(
  command: string,
  args: string[],
  signal: AbortSignal,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      signal,
    });
    return stdout;
  } catch (cause) {
    const stdout = (cause as { stdout?: unknown }).stdout;
    if (typeof stdout === "string" && stdout.trim() !== "") return stdout;
    throw cause;
  }
}

function supported(): boolean {
  return platform() === "darwin" || platform() === "linux";
}

async function listeningSockets(signal: AbortSignal): Promise<Listener[]> {
  const output = await runTolerant(
    "lsof",
    ["-nP", "-iTCP", "-sTCP:LISTEN"],
    signal,
  );
  return parseListeners(output);
}

/** pid → cwd. /proc is authoritative on Linux; macOS needs a second lsof. */
async function workingDirectories(
  pids: number[],
  signal: AbortSignal,
): Promise<Map<number, string>> {
  if (pids.length === 0) return new Map();
  if (platform() === "linux") {
    const cwds = new Map<number, string>();
    await Promise.all(
      pids.map(async (pid) => {
        try {
          cwds.set(pid, await readlink(`/proc/${pid}/cwd`));
        } catch {
          // Process exited between passes, or belongs to another user.
        }
      }),
    );
    return cwds;
  }
  const output = await runTolerant(
    "lsof",
    ["-a", "-p", pids.join(","), "-d", "cwd", "-Fn"],
    signal,
  );
  return parseCwds(output);
}

async function labelsFor(root: PortRoot): Promise<Map<number, PortLabel>> {
  for (const candidate of LABEL_FILES) {
    try {
      return parseLabels(await readFile(join(root.path, candidate), "utf8"));
    } catch {
      // Absent file: try the next candidate, then fall through to no labels.
    }
  }
  return new Map();
}

/** A row before the label pass, which also decides its role. */
type Unlabelled = Omit<ScannedPort, "label" | "scheme" | "role">;

async function dockerPorts(
  roots: PortRoot[],
  signal: AbortSignal,
): Promise<{ ports: Unlabelled[]; error: string | null }> {
  let output: string;
  try {
    output = await execFileAsync(
      "docker",
      [
        "ps",
        "--format",
        '{{.ID}}\t{{.Names}}\t{{.Ports}}\t{{.Label "com.docker.compose.project.working_dir"}}\t{{.Label "com.docker.compose.service"}}',
      ],
      { timeout: EXEC_TIMEOUT_MS, maxBuffer: MAX_BUFFER, signal },
    ).then((result) => result.stdout);
  } catch (cause) {
    // No docker, or the daemon is down: the process pass still stands.
    return { ports: [], error: cause instanceof Error ? cause.message : String(cause) };
  }
  const ports: Unlabelled[] = [];
  for (const row of parseDockerRows(output)) {
    const environmentId = attribute(row.workingDir, roots);
    if (environmentId === null) continue;
    for (const { port, address } of row.ports) {
      ports.push({
        environmentId,
        port,
        address,
        pid: 0,
        processName: "docker",
        source: "docker",
        container: row.name,
        service: row.service,
      });
    }
  }
  return { ports, error: null };
}

interface ScanArgs {
  roots: PortRoot[];
  includeDocker: boolean;
  ignorePorts: number[];
  ignoreProcesses: string[];
}

async function scanPorts(
  { roots, includeDocker, ignorePorts, ignoreProcesses }: ScanArgs,
  signal: AbortSignal,
): Promise<{ ports: ScannedPort[]; scannedAt: number; dockerError: string | null }> {
  if (!supported()) {
    throw new Error(`port scanning is not supported on ${platform()}`);
  }
  if (roots.length === 0) {
    return { ports: [], scannedAt: Date.now(), dockerError: null };
  }

  const ignoredPorts = new Set(ignorePorts);
  const ignoredProcesses = new Set(
    ignoreProcesses.map((name) => name.toLowerCase()),
  );

  const listeners = (await listeningSockets(signal)).filter(
    (listener) =>
      !ignoredPorts.has(listener.port) &&
      !ignoredProcesses.has(listener.processName.toLowerCase()),
  );
  const cwds = await workingDirectories(
    [...new Set(listeners.map((listener) => listener.pid))],
    signal,
  );

  const unlabelled: Unlabelled[] = [];
  for (const listener of listeners) {
    const cwd = cwds.get(listener.pid);
    if (cwd === undefined) continue;
    const environmentId = attribute(cwd, roots);
    if (environmentId === null) continue;
    unlabelled.push({
      environmentId,
      port: listener.port,
      address: listener.address,
      pid: listener.pid,
      processName: listener.processName,
      source: "process",
      container: null,
      service: null,
    });
  }

  let dockerError: string | null = null;
  if (includeDocker) {
    const docker = await dockerPorts(roots, signal);
    dockerError = docker.error;
    for (const row of docker.ports) {
      if (ignoredPorts.has(row.port)) continue;
      unlabelled.push(row);
    }
  }

  const labelsByEnvironment = new Map(
    await Promise.all(
      roots.map(
        async (root) =>
          [root.environmentId, await labelsFor(root)] as const,
      ),
    ),
  );

  // One row per (environment, port): a port published on both IP families, or
  // seen through both the process and docker passes, is still one thing.
  const byKey = new Map<string, ScannedPort>();
  for (const row of unlabelled) {
    const key = `${row.environmentId}:${row.port}`;
    const existing = byKey.get(key);
    if (existing !== undefined && existing.source === "process") continue;
    const known = labelsByEnvironment.get(row.environmentId)?.get(row.port);
    const labelled = { ...row, label: known?.label ?? null, scheme: known?.scheme ?? null };
    byKey.set(key, { ...labelled, role: roleFor(labelled) });
  }

  const ports = [...byKey.values()].sort(
    (left, right) =>
      left.environmentId.localeCompare(right.environmentId) || compareByRole(left, right),
  );
  return { ports, scannedAt: Date.now(), dockerError };
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    scan: (input, context) => scanPorts(input, context.signal),

    // Stop whatever is holding a port. The target is resolved by a fresh scan
    // rather than taken from the caller, so this can only ever stop a process
    // this plugin currently attributes to that worktree.
    release: async ({ environmentId, port, roots, includeDocker }, context) => {
      const { ports } = await scanPorts(
        { roots, includeDocker, ignorePorts: [], ignoreProcesses: [] },
        context.signal,
      );
      const target = ports.find(
        (row) => row.environmentId === environmentId && row.port === port,
      );
      if (target === undefined) {
        return { released: false, detail: `nothing is listening on ${port}` };
      }
      if (target.source === "docker") {
        if (target.container === null) {
          return { released: false, detail: `port ${port} has no container name` };
        }
        await execFileAsync("docker", ["stop", target.container], {
          timeout: 30_000,
          signal: context.signal,
        });
        return { released: true, detail: `stopped container ${target.container}` };
      }
      process.kill(target.pid, "SIGTERM");
      return {
        released: true,
        detail: `sent SIGTERM to ${target.processName} (${target.pid})`,
      };
    },
  },
});
