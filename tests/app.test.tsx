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
      projectName: "My project",
      repoName: "my-repo",
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
          service: null,
          role: "app",
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
          service: "api",
          role: "app",
          label: null,
          scheme: "https",
          url: "https://localhost:4443",
        },
        {
          environmentId: "env_a",
          port: 5432,
          address: "0.0.0.0",
          pid: 0,
          processName: "docker",
          source: "docker",
          container: "repo-postgres-1",
          service: "postgres",
          role: "service",
          label: null,
          scheme: null,
          url: "http://localhost:5432",
        },
        {
          environmentId: "env_a",
          port: 63493,
          address: "127.0.0.1",
          pid: 7,
          processName: "claude",
          source: "process",
          container: null,
          service: null,
          role: "internal",
          label: null,
          scheme: null,
          url: "http://localhost:63493",
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

function card(settings?: Record<string, string>, snapshot: PortSnapshot = SNAPSHOT) {
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
        ports_snapshot: () => snapshot,
        ports_release: () => ({ released: true, detail: "sent SIGTERM to node (42)" }),
      },
      ...(settings === undefined ? {} : { settings }),
      openUrl: () => true,
    },
  );
}

describe("ports card", () => {
  it("leads with named app pills and keeps the rest behind a toggle", async () => {
    const slot = card();
    await slot.findByText("My project · bb/feature");
    expect(slot.queryByText("bb/feature")).toBeNull();
    expect(await slot.findByText(":3000")).toBeTruthy();
    expect(await slot.findByText("Frontend")).toBeTruthy();
    expect(await slot.findByText(":4443")).toBeTruthy();
    expect(await slot.findByText("2 apps, 2 more")).toBeTruthy();
    expect(slot.queryByText("5432")).toBeNull();
    expect(slot.queryByText("postgres")).toBeNull();

    (await slot.findByText("1 service, 1 internal")).click();
    expect(await slot.findByText("postgres")).toBeTruthy();
    expect(await slot.findByText("5432")).toBeTruthy();
    expect(await slot.findByText("claude")).toBeTruthy();
    expect(await slot.findByLabelText("Open http://localhost:63493")).toBeTruthy();
  });

  it("names the machine only when worktrees span more than one", async () => {
    const one = card();
    await one.findByText("My project · bb/feature");
    expect(one.queryByText("Laptop")).toBeNull();
    cleanup();

    const group = SNAPSHOT.groups[0]!;
    const two = card(undefined, {
      ...SNAPSHOT,
      groups: [
        group,
        { ...group, environmentId: "env_b", hostId: "host_2", hostName: "Desktop", branchName: "bb/other" },
      ],
    });
    expect(await two.findByText("Laptop")).toBeTruthy();
    expect(await two.findByText("Desktop")).toBeTruthy();
  });

  it("shows services straight away when a worktree has no app port", async () => {
    const services = {
      ...SNAPSHOT,
      groups: SNAPSHOT.groups.map((group) => ({
        ...group,
        ports: group.ports.filter((port) => port.role === "service"),
      })),
    };
    const slot = card(undefined, services);
    expect(await slot.findByText("postgres")).toBeTruthy();
    expect(await slot.findByText("1 service, no app")).toBeTruthy();
  });

  it("does not call an internal listener a service in the header", async () => {
    const internal = {
      ...SNAPSHOT,
      groups: SNAPSHOT.groups.map((group) => ({
        ...group,
        ports: group.ports.filter((port) => port.role === "internal"),
      })),
    };
    const slot = card(undefined, internal);
    expect(await slot.findByText("1 internal, no app")).toBeTruthy();
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

describe("footer button dot", () => {
  it("appears while the polled snapshot has ports, and goes on dispose", async () => {
    document.body.innerHTML = `
      <div data-sidebar="panel">
        <li data-sidebar="menu-item" class="relative">
          <button data-testid="plugin-sidebar-footer-item-worktree-ports-ports"></button>
        </li>
      </div>`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(SNAPSHOT))));
    const mounted = await mountPluginContentScripts(app, { pluginId: "worktree-ports" });

    const dot = await vi.waitFor(() => {
      const found = document.querySelector("[data-worktree-ports-indicator]");
      expect(found).not.toBeNull();
      return found;
    });
    expect(dot?.getAttribute("aria-label")).toBe("4 ports listening");

    await mounted.lifecycle.dispose();
    expect(document.querySelector("[data-worktree-ports-indicator]")).toBeNull();
    document.body.innerHTML = "";
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
        label: "Frontend :3000 · api :4443 · 2 others",
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
