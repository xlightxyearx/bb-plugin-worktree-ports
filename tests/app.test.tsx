// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import {
  loadPluginApp,
  mountPluginContentScripts,
  renderSlot,
  type CapturedPluginApp,
} from "@get-bb/plugin-sdk/testing/app";
import type { PortSnapshot } from "../server";

const SNAPSHOT: PortSnapshot = {
  scannedAt: 1,
  threadRowIcons: true,
  errors: [],
  groups: [
    {
      environmentId: "env_a",
      hostId: "host_1",
      hostName: "Laptop",
      name: null,
      branchName: "bb/feature",
      path: "/w/env_a/repo",
      projectId: "proj_1",
      threads: [{ id: "thr_1", title: "Feature work" }],
      ports: [
        {
          environmentId: "env_a",
          port: 3000,
          address: "127.0.0.1",
          pid: 42,
          processName: "node",
          source: "process",
          container: null,
          label: "Frontend",
          scheme: null,
          url: "http://localhost:3000",
        },
        {
          environmentId: "env_a",
          port: 4443,
          address: "0.0.0.0",
          pid: 0,
          processName: "docker",
          source: "docker",
          container: "repo-api-1",
          label: null,
          scheme: "https",
          url: "https://localhost:4443",
        },
      ],
    },
  ],
};

let app: CapturedPluginApp;

beforeEach(async () => {
  app = await loadPluginApp(() => import("../app"));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function card(settings?: Record<string, string>) {
  const disclosure = app.experimentalSidebarFooterItems.find(
    (item) => item.id === "ports",
  );
  if (disclosure === undefined || disclosure.kind !== "disclosure") {
    throw new Error("the ports disclosure is not registered");
  }
  return renderSlot(
    disclosure,
    { dismiss: () => {} },
    {
      rpc: {
        ports_snapshot: () => SNAPSHOT,
        ports_release: () => ({ released: true, detail: "sent SIGTERM to node (42)" }),
      },
      ...(settings === undefined ? {} : { settings }),
      openUrl: () => true,
    },
  );
}

describe("ports card", () => {
  it("draws a pill per port under its branch", async () => {
    const slot = card();
    await slot.findByText("bb/feature");
    expect(await slot.findByText("3000")).toBeTruthy();
    expect(await slot.findByText("4443")).toBeTruthy();
    expect(await slot.findByText("Frontend")).toBeTruthy();
    expect(await slot.findByText("2 listening")).toBeTruthy();
  });

  it("hands a plain click to BB's own browser preference", async () => {
    const slot = card();
    (await slot.findByLabelText("Open http://localhost:3000")).click();
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "openUrl", url: "http://localhost:3000" },
    ]);
  });

  it("opens outside BB when the setting says so, and inverts on modifier-click", async () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    const slot = card({ openIn: "System browser" });
    const pill = await slot.findByLabelText("Open https://localhost:4443");

    pill.click();
    expect(open).toHaveBeenCalledWith("https://localhost:4443", "_blank", "noopener,noreferrer");
    expect(slot.inspection.navigateCalls).toEqual([]);

    pill.dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }));
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "openUrl", url: "https://localhost:4443" },
    ]);
  });

  it("releases the port the stop button belongs to", async () => {
    const slot = card();
    (await slot.findByLabelText("Stop whatever is listening on 3000")).click();
    await slot.findByText("sent SIGTERM to node (42)");
    expect(slot.inspection.rpcCalls.map((call) => call.method)).toContain("ports_release");
    expect(
      slot.inspection.rpcCalls.find((call) => call.method === "ports_release")?.input,
    ).toEqual({ environmentId: "env_a", port: 3000 });
  });
});

describe("thread row glyphs", () => {
  it("marks every thread whose worktree is listening, and clears on unmount", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(SNAPSHOT))),
    );
    const mounted = await mountPluginContentScripts(app, { pluginId: "worktree-ports" });
    await vi.waitFor(() =>
      expect(mounted.inspection.getThreadRowStatus("thr_1")).toEqual({
        icon: "ElectricPlugs",
        label: "2 listening: 3000, 4443",
        tone: "success",
      }),
    );

    await mounted.lifecycle.dispose();
    expect(mounted.inspection.getThreadRowStatus("thr_1")).toBeNull();
  });

  it("paints nothing when the setting is off", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ...SNAPSHOT, threadRowIcons: false }))),
    );
    const mounted = await mountPluginContentScripts(app, { pluginId: "worktree-ports" });
    await vi.waitFor(() => expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0));
    expect(mounted.inspection.getThreadRowStatus("thr_1")).toBeNull();
    await mounted.lifecycle.dispose();
  });
});
