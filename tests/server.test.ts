import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { nextDelayMs } from "../src/cadence";
import type { ScannedPort } from "../src/contract";

const THREADS = [
  { id: "thr_1", title: "Feature work", titleFallback: null, environmentId: "env_a" },
  { id: "thr_2", title: null, titleFallback: "Second thread", environmentId: "env_a" },
  { id: "thr_3", title: "Quiet worktree", titleFallback: null, environmentId: "env_b" },
  { id: "thr_4", title: "No workspace yet", titleFallback: null, environmentId: null },
];

const ENVIRONMENTS: Record<string, Record<string, unknown>> = {
  env_a: {
    id: "env_a",
    hostId: "host_1",
    path: "/w/env_a/repo",
    name: null,
    branchName: "bb/feature",
    projectId: "proj_1",
    status: "ready",
  },
  env_b: {
    id: "env_b",
    hostId: "host_2",
    path: "/w/env_b/repo",
    name: null,
    branchName: "bb/quiet",
    projectId: "proj_1",
    status: "ready",
  },
};

function port(overrides: Partial<ScannedPort> & { port: number }): ScannedPort {
  return {
    environmentId: "env_a",
    address: "127.0.0.1",
    pid: 42,
    processName: "node",
    source: "process",
    container: null,
    label: null,
    scheme: null,
    ...overrides,
  };
}

function host(
  onHostRpc: (call: { method: string; input: unknown; hostId?: string }) => unknown,
  settings: Record<string, string | number | boolean> = {},
) {
  return createFakePluginHost({
    pluginId: "worktree-ports",
    experimental_hostEntry: true,
    settings,
    sdk: {
      threads: { list: async () => THREADS },
      environments: {
        get: async ({ environmentId }: { environmentId: string }) => {
          const environment = ENVIRONMENTS[environmentId];
          if (environment === undefined) throw new Error(`no ${environmentId}`);
          return environment;
        },
      },
      hosts: {
        list: async () => [
          { id: "host_1", name: "Laptop" },
          { id: "host_2", name: "Desktop" },
        ],
      },
    },
    experimental_callHostRpc: (call) => onHostRpc(call),
  });
}

describe("bb ports list", () => {
  it("groups ports under the worktree that owns them, naming every thread's branch", async () => {
    const { bb, harness } = host(({ method }) => {
      if (method !== "scan") throw new Error(`unexpected ${method}`);
      return {
        ports: [port({ port: 3000, label: "Frontend" })],
        scannedAt: 1,
        dockerError: null,
      };
    });
    await plugin(bb);

    const result = await harness.behavior.runCli(["list", "--json"]);
    expect(result.exitCode).toBe(0);
    const snapshot = JSON.parse(result.stdout ?? "{}");
    expect(snapshot.groups).toHaveLength(1);
    expect(snapshot.groups[0].environmentId).toBe("env_a");
    expect(snapshot.groups[0].hostName).toBe("Laptop");
    expect(snapshot.groups[0].threads).toEqual([
      { id: "thr_1", title: "Feature work" },
      { id: "thr_2", title: "Second thread" },
    ]);
    expect(snapshot.groups[0].ports[0].url).toBe("http://localhost:3000");
  });

  it("asks each machine about its own worktrees only", async () => {
    const calls: { hostId?: string; roots: unknown }[] = [];
    const { bb, harness } = host((call) => {
      calls.push({
        hostId: call.hostId,
        roots: (call.input as { roots: unknown }).roots,
      });
      return { ports: [], scannedAt: 1, dockerError: null };
    });
    await plugin(bb);
    await harness.behavior.runCli(["list"]);

    expect(calls).toHaveLength(2);
    expect(calls.find((call) => call.hostId === "host_1")?.roots).toEqual([
      { environmentId: "env_a", path: "/w/env_a/repo" },
    ]);
    expect(calls.find((call) => call.hostId === "host_2")?.roots).toEqual([
      { environmentId: "env_b", path: "/w/env_b/repo" },
    ]);
  });

  it("passes the ignore settings through as parsed values", async () => {
    const inputs: Record<string, unknown>[] = [];
    const { bb, harness } = host(
      (call) => {
        inputs.push(call.input as Record<string, unknown>);
        return { ports: [], scannedAt: 1, dockerError: null };
      },
      { ignorePorts: "5432, 7687", ignoreProcesses: "Spotify rapportd", includeDocker: false },
    );
    await plugin(bb);
    await harness.behavior.runCli(["list"]);

    expect(inputs[0]).toMatchObject({
      ignorePorts: [5432, 7687],
      ignoreProcesses: ["Spotify", "rapportd"],
      includeDocker: false,
    });
  });

  it("reports a machine that could not be scanned instead of hiding it", async () => {
    const { bb, harness } = host(({ hostId }) => {
      if (hostId === "host_2") throw new Error("lsof: command not found");
      return { ports: [port({ port: 3000 })], scannedAt: 1, dockerError: null };
    });
    await plugin(bb);

    const snapshot = JSON.parse((await harness.behavior.runCli(["list", "--json"])).stdout ?? "{}");
    expect(snapshot.errors).toEqual([
      { hostId: "host_2", message: "lsof: command not found" },
    ]);
    expect(snapshot.groups).toHaveLength(1);
  });

  it("says so plainly when nothing is listening", async () => {
    const { bb, harness } = host(() => ({ ports: [], scannedAt: 1, dockerError: null }));
    await plugin(bb);
    const result = await harness.behavior.runCli(["list"]);
    expect(result.stdout).toBe("No listening ports in any workspace.");
  });
});

describe("the scanner service", () => {
  it("only signals clients when what is listening actually changed", async () => {
    let ports: ScannedPort[] = [port({ port: 3000 })];
    const { bb, harness } = host(
      ({ hostId }) => ({
        ports: hostId === "host_1" ? ports : [],
        scannedAt: 1,
        dockerError: null,
      }),
      {
        scanIntervalSec: 1,
      },
    );
    await plugin(bb);

    const service = harness.behavior.runService("port-scanner");
    await vi.waitFor(() => expect(harness.realtimeSignals.length).toBe(1));
    await vi.waitFor(() => expect(harness.realtimeSignals.length).toBe(1), { timeout: 1500 });
    ports = [port({ port: 3000 }), port({ port: 3001 })];
    await vi.waitFor(() => expect(harness.realtimeSignals.length).toBe(2), { timeout: 3000 });
    expect(harness.realtimeSignals.at(-1)).toMatchObject({
      channel: "ports-changed",
      payload: { groups: 1, ports: 2 },
    });

    service.controller.abort();
    await service.done;
  });
});

describe("bb ports release", () => {
  it("routes to the machine holding that worktree", async () => {
    const calls: { method: string; hostId?: string; input: unknown }[] = [];
    const { bb, harness } = host((call) => {
      calls.push(call);
      return call.method === "scan"
        ? { ports: [], scannedAt: 1, dockerError: null }
        : { released: true, detail: "sent SIGTERM to node (42)" };
    });
    await plugin(bb);

    const result = await harness.behavior.runCli(["release", "env_b", "3000"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("sent SIGTERM to node (42)");
    const release = calls.find((call) => call.method === "release");
    expect(release?.hostId).toBe("host_2");
    expect(release?.input).toMatchObject({
      environmentId: "env_b",
      port: 3000,
      roots: [{ environmentId: "env_b", path: "/w/env_b/repo" }],
    });
  });

  it("refuses an environment it does not know", async () => {
    const { bb, harness } = host(() => ({ ports: [], scannedAt: 1, dockerError: null }));
    await plugin(bb);
    const result = await harness.behavior.runCli(["release", "env_zz", "3000"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown environment env_zz");
  });
});

describe("cross-machine attribution", () => {
  it("ignores ports a machine reports for a worktree it was not asked about", async () => {
    const { bb, harness } = host(({ hostId }) => ({
      // host_2 wrongly answers for env_a, which lives on host_1.
      ports: [port({ port: hostId === "host_1" ? 3000 : 9999 })],
      scannedAt: 1,
      dockerError: null,
    }));
    await plugin(bb);

    const snapshot = JSON.parse((await harness.behavior.runCli(["list", "--json"])).stdout ?? "{}");
    expect(snapshot.groups).toHaveLength(1);
    expect(snapshot.groups[0].ports.map((entry: { port: number }) => entry.port)).toEqual([3000]);
  });
});

describe("scan cadence", () => {
  it("holds the base interval until scans have been idle, then backs off to the cap", () => {
    expect(nextDelayMs(3_000, 0)).toBe(3_000);
    expect(nextDelayMs(3_000, 19)).toBe(3_000);
    expect(nextDelayMs(3_000, 20)).toBe(15_000);
    expect(nextDelayMs(10_000, 40)).toBe(30_000);
  });

  it("answers the card from a fresh scan only when the last one is stale", async () => {
    let scans = 0;
    const { bb, harness } = host(
      () => {
        scans += 1;
        return { ports: [port({ port: 3000 })], scannedAt: 1, dockerError: null };
      },
      { scanIntervalSec: 1 },
    );
    await plugin(bb);

    // Nothing scanned yet, so the first read scans both machines.
    await harness.behavior.callRpc("ports_snapshot", null);
    expect(scans).toBe(2);

    // A second read within the interval reuses that scan.
    await harness.behavior.callRpc("ports_snapshot", null);
    expect(scans).toBe(2);

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await harness.behavior.callRpc("ports_snapshot", null);
    expect(scans).toBe(4);
  });
});
