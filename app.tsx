// bb-plugin-worktree-ports — frontend entry. A sidebar-footer disclosure with
// one pill per listening port, plus an icon on the sidebar rows of threads
// whose worktree is serving something.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import type { PortSnapshot } from "./server";
import { createFooterIndicator } from "./src/ui/footer-indicator";
import { PortsCard } from "./src/ui/ports-card";

const PLUGIN_ID = "worktree-ports";
const FOOTER_ITEM_ID = "ports";
const SNAPSHOT_URL = `/api/v1/plugins/${PLUGIN_ID}/http/snapshot`;
const POLL_MS = 5_000;

export default definePluginApp((app) => {
  app.experimental_sidebarFooter.register({
    kind: "disclosure",
    id: FOOTER_ITEM_ID,
    label: "Worktree ports",
    icon: "ElectricPlugs",
    component: PortsCard,
  });

  // Content scripts have no hooks, so this polls the same snapshot over HTTP,
  // paints one glyph per thread whose worktree has a listener, and dots the
  // footer button so the card announces itself without being open.
  app.contentScripts.register({
    id: "thread-row-ports",
    mount({ signal, experimental_setThreadRowStatus: setStatus }) {
      const painted = new Set<string>();
      const indicator = createFooterIndicator(PLUGIN_ID, FOOTER_ITEM_ID);
      let timer: number | null = null;

      const paint = (snapshot: PortSnapshot) => {
        indicator.set(
          snapshot.groups.reduce((total, group) => total + group.ports.length, 0),
        );
        if (setStatus === undefined) return;
        const next = new Set<string>();
        if (snapshot.threadRowIcons) {
          for (const group of snapshot.groups) {
            const ports = group.ports.map((port) => port.port).join(", ");
            for (const thread of group.threads) {
              next.add(thread.id);
              setStatus(thread.id, {
                icon: "ElectricPlugs",
                label: `${group.ports.length} listening: ${ports}`,
                tone: "success",
              });
            }
          }
        }
        for (const threadId of painted) {
          if (!next.has(threadId)) setStatus(threadId, null);
        }
        painted.clear();
        for (const threadId of next) painted.add(threadId);
      };

      const poll = async () => {
        if (signal.aborted) return;
        try {
          const response = await fetch(SNAPSHOT_URL, { signal });
          const body = response.ok ? ((await response.json()) as PortSnapshot) : null;
          // The disclosure can be torn down mid-poll; painting after that
          // would resurrect glyphs the cleanup just cleared.
          if (body !== null && !signal.aborted) paint(body);
        } catch {
          // A failed poll leaves the previous glyphs; the next one reconciles.
        }
        if (!signal.aborted) timer = window.setTimeout(poll, POLL_MS);
      };
      void poll();

      // Statuses are cleared by the host when this generation deactivates;
      // the disposer only has to stop the poll.
      return () => {
        if (timer !== null) window.clearTimeout(timer);
        indicator.dispose();
        painted.clear();
      };
    },
  });
});
