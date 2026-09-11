// The sidebar-footer disclosure: every worktree with something listening,
// one pill per port.
import { useCallback, useEffect, useState } from "react";
import type { MouseEvent } from "react";
import { useBbNavigate, useRealtime, useRpc, useSettings } from "@get-bb/plugin-sdk/app";
import type { PortGroup, PortSnapshot, rpcContract } from "../../server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

const EMPTY: PortSnapshot = { groups: [], scannedAt: 0, threadRowIcons: true, errors: [] };

export function useSnapshot() {
  const rpc = useRpc<typeof rpcContract>();
  const [snapshot, setSnapshot] = useState<PortSnapshot>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    rpc.call("ports_snapshot").then(
      (next) => {
        setSnapshot(next);
        setError(null);
      },
      (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime("ports-changed", refetch);
  return { snapshot, error, refetch, rpc };
}

/**
 * Plain click follows the "Open ports in" setting; the modifier does the
 * other thing, so the less-used target never needs a settings trip.
 */
function useOpenPort() {
  const navigate = useBbNavigate();
  const { values } = useSettings();
  return useCallback(
    (url: string, event: MouseEvent) => {
      const preferSystem = values?.openIn === "System browser";
      const useSystem = event.metaKey || event.ctrlKey ? !preferSystem : preferSystem;
      if (useSystem) window.open(url, "_blank", "noopener,noreferrer");
      else navigate.openUrl(url);
    },
    [navigate, values],
  );
}

function GroupRow({
  group,
  onRelease,
}: {
  group: PortGroup;
  onRelease: (port: number) => void;
}) {
  const openPort = useOpenPort();
  const subtitle = group.threads[0]?.title ?? group.path;
  return (
    <li className="py-2">
      <div className="flex items-baseline gap-2">
        <Icon name="GitBranch" className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {group.branchName ?? group.name ?? group.path}
        </span>
        {group.hostName === null ? null : (
          <span className="shrink-0 text-[10px] text-muted-foreground">{group.hostName}</span>
        )}
      </div>
      <p className="truncate pl-5 text-[11px] text-muted-foreground">{subtitle}</p>
      <div className="flex flex-wrap gap-1.5 pl-5 pt-1.5">
        {group.ports.map((port) => (
          <span
            key={port.port}
            className="group/pill relative inline-flex"
            title={`${port.url} — ${
              port.container === null ? port.processName : `container ${port.container}`
            }${port.label === null ? "" : ` — ${port.label}`}`}
          >
            <Button
              variant="secondary"
              size="sm"
              className="h-6 gap-1 rounded-full border border-timeline-accent/30 bg-timeline-accent/12 px-2 font-mono text-[11px] text-timeline-accent hover:bg-timeline-accent/20"
              aria-label={`Open ${port.url}`}
              onClick={(event) => openPort(port.url, event)}
            >
              {port.port}
              {port.label === null ? null : (
                <span className="max-w-24 truncate font-sans text-[10px] text-timeline-accent/70">
                  {port.label}
                </span>
              )}
              <Icon name="ExternalLink" className="size-2.5 opacity-60" />
            </Button>
            <button
              type="button"
              aria-label={`Stop whatever is listening on ${port.port}`}
              title={`Stop ${
                port.container === null ? port.processName : `container ${port.container}`
              }`}
              className={cn(
                "absolute -right-1 -top-1 hidden size-4 items-center justify-center rounded-full",
                "bg-destructive text-destructive-foreground group-hover/pill:flex",
              )}
              onClick={() => onRelease(port.port)}
            >
              <Icon name="Square" className="size-2" />
            </button>
          </span>
        ))}
      </div>
    </li>
  );
}

export function PortsCard() {
  const { snapshot, error, refetch, rpc } = useSnapshot();
  const [notice, setNotice] = useState<string | null>(null);
  const release = useCallback(
    (environmentId: string, port: number) => {
      rpc.call("ports_release", { environmentId, port }).then(
        (result) => {
          setNotice(result.detail);
          refetch();
        },
        (cause: unknown) => setNotice(cause instanceof Error ? cause.message : String(cause)),
      );
    },
    [refetch, rpc],
  );

  const total = snapshot.groups.reduce((sum, group) => sum + group.ports.length, 0);
  return (
    <div className="max-h-96 overflow-y-auto p-3 text-sm">
      <div className="flex items-center justify-between pb-1">
        <span className="text-xs font-medium">Worktree ports</span>
        <span className="text-[11px] text-muted-foreground">
          {total === 0 ? "none listening" : `${total} listening`}
        </span>
      </div>
      {error === null ? null : <p className="py-2 text-xs text-destructive">{error}</p>}
      {snapshot.errors.map((hostError) => (
        <p key={hostError.hostId} className="py-1 text-xs text-destructive">
          {hostError.hostId}: {hostError.message}
        </p>
      ))}
      {snapshot.groups.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
          Nothing is listening in any workspace yet.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {snapshot.groups.map((group) => (
            <GroupRow
              key={group.environmentId}
              group={group}
              onRelease={(port) => release(group.environmentId, port)}
            />
          ))}
        </ul>
      )}
      {notice === null ? null : (
        <p className="pt-2 text-[11px] text-muted-foreground">{notice}</p>
      )}
    </div>
  );
}
