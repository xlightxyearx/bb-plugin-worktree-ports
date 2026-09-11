// bb-plugin-worktree-ports — backend entry. Resolves every environment BB
// knows about to a worktree path, has each machine's host worker scan its own
// listeners, and serves the result to the sidebar card, `bb ports`, and agents.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { nextDelayMs } from "./src/cadence";
import { hostContract, scannedPortSchema, type PortRoot, type ScannedPort } from "./src/contract";
import { describe, urlFor } from "./src/labels";

export type { ScannedPort } from "./src/contract";

const PORTS_CHANGED = "ports-changed";
const ENVIRONMENT_CACHE_MS = 30_000;
const THREAD_LIMIT = 500;

const groupSchema = z.object({
  environmentId: z.string(),
  hostId: z.string(),
  hostName: z.string().nullable(),
  name: z.string().nullable(),
  branchName: z.string().nullable(),
  path: z.string(),
  projectId: z.string(),
  threads: z.array(z.object({ id: z.string(), title: z.string() })),
  ports: z.array(scannedPortSchema.extend({ url: z.string() })),
});
export type PortGroup = z.infer<typeof groupSchema>;

const snapshotSchema = z.object({
  groups: z.array(groupSchema),
  scannedAt: z.number(),
  /** Mirrors the setting so the hookless thread-row script can honor it. */
  threadRowIcons: z.boolean(),
  /** Per-machine scan failures, shown in the card rather than swallowed. */
  errors: z.array(z.object({ hostId: z.string(), message: z.string() })),
});
export type PortSnapshot = z.infer<typeof snapshotSchema>;

export const rpcContract = defineRpcContract({
  ports_snapshot: { input: z.null(), output: snapshotSchema },
  ports_release: {
    input: z.object({ environmentId: z.string().min(1), port: z.number().int() }),
    output: z.object({ released: z.boolean(), detail: z.string() }),
  },
});

function parseList(value: string): string[] {
  return value
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    scanIntervalSec: {
      type: "number",
      label: "Scan interval (seconds)",
      experimental_schema: z.number().int().min(1).max(60),
      default: 3,
    },
    includeDocker: {
      type: "boolean",
      label: "Include Docker published ports",
      default: true,
    },
    ignorePorts: {
      type: "string",
      label: "Ignore ports (comma separated)",
      default: "",
    },
    ignoreProcesses: {
      type: "string",
      label: "Ignore processes (comma separated)",
      default: "",
    },
    openIn: {
      type: "select",
      label: "Open ports in",
      options: ["BB browser preference", "System browser"],
      default: "BB browser preference",
    },
    showThreadRowIcon: {
      type: "boolean",
      label: "Mark sidebar threads that have listening ports",
      default: true,
    },
  });

  const host = bb.hosts.experimental_client({ contract: hostContract });

  interface EnvironmentFacts {
    hostId: string;
    path: string;
    name: string | null;
    branchName: string | null;
    projectId: string;
  }
  const environmentCache = new Map<
    string,
    { loadedAt: number; facts: EnvironmentFacts | null }
  >();
  const hostNames = new Map<string, string>();
  let hostNamesLoadedAt = 0;

  async function environmentFacts(
    environmentId: string,
  ): Promise<EnvironmentFacts | null> {
    const cached = environmentCache.get(environmentId);
    if (cached !== undefined && Date.now() - cached.loadedAt < ENVIRONMENT_CACHE_MS) {
      return cached.facts;
    }
    let facts: EnvironmentFacts | null = null;
    try {
      const environment = await bb.sdk.environments.get({ environmentId });
      // A provisioning or destroyed worktree has nothing worth scanning.
      if (environment.path !== null && environment.status === "ready") {
        facts = {
          hostId: environment.hostId,
          path: environment.path,
          name: environment.name,
          branchName: environment.branchName,
          projectId: environment.projectId,
        };
      }
    } catch (cause) {
      bb.log.debug(`environment ${environmentId} unreadable: ${String(cause)}`);
    }
    environmentCache.set(environmentId, { loadedAt: Date.now(), facts });
    return facts;
  }

  async function hostName(hostId: string): Promise<string | null> {
    if (Date.now() - hostNamesLoadedAt > ENVIRONMENT_CACHE_MS) {
      try {
        for (const entry of await bb.sdk.hosts.list()) {
          hostNames.set(entry.id, entry.name);
        }
        hostNamesLoadedAt = Date.now();
      } catch (cause) {
        bb.log.debug(`host list unreadable: ${String(cause)}`);
      }
    }
    return hostNames.get(hostId) ?? null;
  }

  interface Workspace extends EnvironmentFacts {
    environmentId: string;
    threads: { id: string; title: string }[];
  }

  /** Every live environment with a workspace on disk, plus the threads using it. */
  async function workspaces(): Promise<Workspace[]> {
    const threads = await bb.sdk.threads.list({
      archived: false,
      includeHidden: true,
      limit: THREAD_LIMIT,
    });
    const byEnvironment = new Map<string, { id: string; title: string }[]>();
    for (const thread of threads) {
      if (thread.environmentId === null) continue;
      const title = thread.title ?? thread.titleFallback ?? "Untitled";
      const existing = byEnvironment.get(thread.environmentId);
      if (existing === undefined) byEnvironment.set(thread.environmentId, [{ id: thread.id, title }]);
      else existing.push({ id: thread.id, title });
    }
    const resolved = await Promise.all(
      [...byEnvironment].map(async ([environmentId, threadRows]) => {
        const facts = await environmentFacts(environmentId);
        return facts === null ? null : { environmentId, threads: threadRows, ...facts };
      }),
    );
    return resolved.filter((entry): entry is Workspace => entry !== null);
  }

  let snapshot: PortSnapshot = { groups: [], scannedAt: 0, threadRowIcons: true, errors: [] };
  let signature = "";
  let idleScans = 0;

  async function scan(signal: AbortSignal): Promise<PortSnapshot> {
    const current = await settings.get();
    const found = await workspaces();
    const rootsByHost = new Map<string, PortRoot[]>();
    for (const workspace of found) {
      const roots = rootsByHost.get(workspace.hostId);
      const root = { environmentId: workspace.environmentId, path: workspace.path };
      if (roots === undefined) rootsByHost.set(workspace.hostId, [root]);
      else roots.push(root);
    }

    const ignorePorts = parseList(current.ignorePorts)
      .map((entry) => Number.parseInt(entry, 10))
      .filter((port) => Number.isInteger(port) && port >= 1 && port <= 65535);
    const ignoreProcesses = parseList(current.ignoreProcesses);

    const ports: ScannedPort[] = [];
    const errors: { hostId: string; message: string }[] = [];
    await Promise.all(
      [...rootsByHost].map(async ([hostId, roots]) => {
        try {
          const result = await host.call(
            "scan",
            {
              roots,
              includeDocker: current.includeDocker,
              ignorePorts,
              ignoreProcesses,
            },
            { hostId, signal },
          );
          // A machine only answers for the worktrees it was asked about.
          const own = new Set(roots.map((root) => root.environmentId));
          ports.push(...result.ports.filter((port) => own.has(port.environmentId)));
        } catch (cause) {
          errors.push({
            hostId,
            message: cause instanceof Error ? cause.message : String(cause),
          });
        }
      }),
    );

    const portsByEnvironment = new Map<string, ScannedPort[]>();
    for (const port of ports) {
      const existing = portsByEnvironment.get(port.environmentId);
      if (existing === undefined) portsByEnvironment.set(port.environmentId, [port]);
      else existing.push(port);
    }

    const groups: PortGroup[] = [];
    for (const workspace of found) {
      const own = portsByEnvironment.get(workspace.environmentId);
      if (own === undefined || own.length === 0) continue;
      groups.push({
        environmentId: workspace.environmentId,
        hostId: workspace.hostId,
        hostName: await hostName(workspace.hostId),
        name: workspace.name,
        branchName: workspace.branchName,
        path: workspace.path,
        projectId: workspace.projectId,
        threads: workspace.threads,
        ports: own.map((port) => ({ ...port, url: urlFor(port) })),
      });
    }
    groups.sort((left, right) =>
      (left.branchName ?? left.path).localeCompare(right.branchName ?? right.path),
    );
    return {
      groups,
      scannedAt: Date.now(),
      threadRowIcons: current.showThreadRowIcon,
      errors,
    };
  }

  function publishIfChanged(next: PortSnapshot): void {
    // scannedAt always moves; only a real change in what is listening is news.
    const nextSignature = JSON.stringify([
      next.threadRowIcons,
      next.groups.map((group) => [
        group.environmentId,
        group.branchName,
        group.threads.map((thread) => thread.id),
        group.ports.map((port) => [port.port, port.pid, port.label, port.container]),
      ]),
      next.errors,
    ]);
    snapshot = next;
    if (nextSignature === signature) {
      idleScans += 1;
      return;
    }
    signature = nextSignature;
    idleScans = 0;
    bb.realtime.publish(PORTS_CHANGED, {
      groups: next.groups.length,
      ports: next.groups.reduce((total, group) => total + group.ports.length, 0),
    });
  }

  bb.background.service("port-scanner", {
    async start(signal) {
      while (!signal.aborted) {
        const { scanIntervalSec } = await settings.get();
        try {
          publishIfChanged(await scan(signal));
        } catch (cause) {
          if (!signal.aborted) bb.log.warn(`scan failed: ${String(cause)}`);
        }
        await sleep(nextDelayMs(scanIntervalSec * 1000, idleScans), signal);
      }
    },
  });

  async function releasePort(
    environmentId: string,
    port: number,
  ): Promise<{ released: boolean; detail: string }> {
    const current = await settings.get();
    const workspace = (await workspaces()).find(
      (candidate) => candidate.environmentId === environmentId,
    );
    if (workspace === undefined) throw new Error(`unknown environment ${environmentId}`);
    return host.call(
      "release",
      {
        environmentId,
        port,
        roots: [{ environmentId, path: workspace.path }],
        includeDocker: current.includeDocker,
      },
      { hostId: workspace.hostId },
    );
  }

  // The thread-row content script has no hooks, so it reads the same snapshot
  // over plain fetch from the app origin.
  bb.http.route("GET", "/snapshot", () => Response.json(snapshot));

  bb.rpc.register(rpcContract, {
    // Someone is looking: answer from a fresh scan when the sweep has backed
    // off or has not run yet, and put the sweep back on its fast cadence.
    ports_snapshot: async () => {
      const { scanIntervalSec } = await settings.get();
      if (Date.now() - snapshot.scannedAt > scanIntervalSec * 1000) {
        publishIfChanged(await scan(new AbortController().signal));
      }
      idleScans = 0;
      return snapshot;
    },
    ports_release: ({ environmentId, port }) => releasePort(environmentId, port),
  });

  // App ports lead, then backing services, then internal listeners, so the
  // first line under a worktree is the one to open.
  function formatSnapshot(value: PortSnapshot): string {
    if (value.groups.length === 0) return "No listening ports in any workspace.";
    const lines: string[] = [];
    for (const group of value.groups) {
      lines.push(`${group.branchName ?? group.name ?? group.path}  (${group.path})`);
      for (const role of ["app", "service", "internal"] as const) {
        const rows = group.ports.filter((port) => port.role === role);
        if (rows.length === 0) continue;
        if (role !== "app") lines.push(`  ${role}:`);
        for (const port of rows) {
          lines.push(`  ${String(port.port).padEnd(6)} ${port.url}  ${describe(port)}`);
        }
      }
    }
    for (const error of value.errors) lines.push(`! ${error.hostId}: ${error.message}`);
    return lines.join("\n");
  }

  const usage = ["Usage:", "  bb ports list [--json]", "  bb ports release <environment-id> <port>"].join("\n");

  bb.cli.register({
    name: "ports",
    summary: "Show the ports listening in each BB workspace",
    commands: [
      { name: "list", summary: "List listening ports per workspace", usage: "bb ports list [--json]" },
      {
        name: "release",
        summary: "Stop whatever holds a workspace port",
        usage: "bb ports release <environment-id> <port>",
      },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const [command, ...args] = argv.filter((arg) => arg !== "--json");
      switch (command) {
        case undefined:
        case "list": {
          // The CLI must answer even before the first sweep lands.
          const value = snapshot.scannedAt === 0 ? await scan(new AbortController().signal) : snapshot;
          return {
            exitCode: 0,
            stdout: json ? JSON.stringify(value) : formatSnapshot(value),
          };
        }
        case "release": {
          const [environmentId, portArg] = args;
          const port = Number.parseInt(portArg ?? "", 10);
          if (environmentId === undefined || !Number.isInteger(port)) break;
          const result = await releasePort(environmentId, port);
          return {
            exitCode: result.released ? 0 : 1,
            ...(result.released ? { stdout: result.detail } : { stderr: result.detail }),
          };
        }
        case "help":
        case "--help":
          return { exitCode: 0, stdout: usage };
      }
      return { exitCode: 1, stderr: usage };
    },
  });

  bb.agents.registerTool({
    name: "worktree_ports",
    description:
      "List the TCP ports currently listening in each BB workspace (worktree), with the owning process or container and the URL that reaches it.",
    presentation: {
      label: { pending: "Reading workspace ports", completed: "Read workspace ports" },
    },
    parameters: z.object({
      environmentId: z
        .string()
        .optional()
        .describe("Limit the answer to one environment id (env_*)."),
    }),
    execute: async ({ environmentId }) => {
      const value = snapshot.scannedAt === 0 ? await scan(new AbortController().signal) : snapshot;
      const scoped =
        environmentId === undefined
          ? value
          : { ...value, groups: value.groups.filter((group) => group.environmentId === environmentId) };
      return formatSnapshot(scoped);
    },
  });

  bb.onDispose(() => {
    environmentCache.clear();
  });
}
