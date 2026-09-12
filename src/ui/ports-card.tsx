// The sidebar-footer disclosure: every worktree with something listening.
// App ports lead as named pills; backing services and internal listeners sit
// behind a muted toggle so the thing to open is never hunted for.
import { useCallback, useEffect, useState } from "react";
import type { MouseEvent } from "react";
import { useBbNavigate, useRealtime, useRpc, useSettings } from "@get-bb/plugin-sdk/app";
import type { PortGroup, PortSnapshot, rpcContract } from "../../server";
import { pillName } from "../labels";
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

type Port = PortGroup["ports"][number];

function ownerOf(port: Port): string {
  return port.container === null ? port.processName : `container ${port.container}`;
}

function Pill({
  port,
  onRelease,
  muted,
}: {
  port: Port;
  onRelease: (port: number) => void;
  muted: boolean;
}) {
  const openPort = useOpenPort();
  return (
    <span
      className={cn(
        "group/pill inline-flex h-6 items-center rounded-full border pl-2 pr-1 text-[11px] transition-colors",
        muted
          ? "border-border bg-muted/40 text-muted-foreground hover:border-foreground/30 hover:bg-muted hover:text-foreground"
          : "border-timeline-accent/30 bg-timeline-accent/12 text-timeline-accent hover:border-timeline-accent hover:bg-timeline-accent/25",
      )}
      title={`${port.url} — ${ownerOf(port)}${port.label === null ? "" : ` — ${port.label}`}`}
    >
      <button
        type="button"
        className="flex items-center gap-1 pr-1"
        aria-label={`Open ${port.url}`}
        onClick={(event) => openPort(port.url, event)}
      >
        <span className={cn("max-w-28 truncate", muted ? "" : "font-medium")}>{pillName(port)}</span>
        <span className="font-mono opacity-80">{muted ? port.port : `:${port.port}`}</span>
      </button>
      <span className="relative flex size-4 items-center justify-center">
        <Icon name="ExternalLink" className="size-3 opacity-60 group-hover/pill:hidden" />
        <button
          type="button"
          aria-label={`Stop whatever is listening on ${port.port}`}
          title={`Stop ${ownerOf(port)}`}
          className="hidden size-4 items-center justify-center rounded-full text-destructive hover:bg-destructive hover:text-destructive-foreground group-hover/pill:flex"
          onClick={() => onRelease(port.port)}
        >
          <Icon name="Square" className="size-2.5" />
        </button>
      </span>
    </span>
  );
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function GroupRow({
  group,
  onRelease,
  showHost,
}: {
  group: PortGroup;
  onRelease: (port: number) => void;
  showHost: boolean;
}) {
  const apps = group.ports.filter((port) => port.role === "app");
  const services = group.ports.filter((port) => port.role === "service");
  const internal = group.ports.filter((port) => port.role === "internal");
  // With no app to lead, the services are the story; show them straight away.
  const [showRest, setShowRest] = useState(apps.length === 0);
  const restSummary = [
    services.length > 0 ? plural(services.length, "service") : null,
    internal.length > 0 ? plural(internal.length, "internal") : null,
  ]
    .filter((part) => part !== null)
    .join(", ");
  const subtitle = group.threads[0]?.title ?? group.path;
  return (
    <li className="py-2">
      <div className="flex items-baseline gap-2">
        <Icon name="GitBranch" className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {group.branchName ?? group.name ?? group.path}
        </span>
        {!showHost || group.hostName === null ? null : (
          <span className="shrink-0 text-[10px] text-muted-foreground">{group.hostName}</span>
        )}
      </div>
      <p className="truncate pl-5 text-[11px] text-muted-foreground">{subtitle}</p>
      {apps.length === 0 ? null : (
        <div className="flex flex-wrap gap-1.5 pl-5 pt-1.5">
          {apps.map((port) => (
            <Pill key={port.port} port={port} onRelease={onRelease} muted={false} />
          ))}
        </div>
      )}
      {restSummary === "" ? null : (
        <button
          type="button"
          aria-expanded={showRest}
          className="flex items-center gap-1 pl-5 pt-1.5 text-[10px] text-muted-foreground hover:text-foreground"
          onClick={() => setShowRest((open) => !open)}
        >
          <Icon
            name="ChevronRight"
            className={cn("size-2.5 transition-transform", showRest ? "rotate-90" : "")}
          />
          {restSummary}
        </button>
      )}
      {showRest && restSummary !== "" ? (
        <div className="flex flex-wrap gap-1.5 pl-5 pt-1">
          {[...services, ...internal].map((port) => (
            <Pill key={port.port} port={port} onRelease={onRelease} muted />
          ))}
        </div>
      ) : null}
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

  const ports = snapshot.groups.flatMap((group) => group.ports);
  // The machine name only disambiguates once worktrees span more than one.
  const showHost = new Set(snapshot.groups.map((group) => group.hostId)).size > 1;
  const apps = ports.filter((port) => port.role === "app").length;
  const services = ports.filter((port) => port.role === "service").length;
  const internal = ports.length - apps - services;
  const headline =
    ports.length === 0
      ? "none listening"
      : apps > 0
        ? `${plural(apps, "app")}${ports.length > apps ? `, ${ports.length - apps} more` : ""}`
        : services > 0
          ? `${plural(services, "service")}, no app`
          : `${plural(internal, "internal")}, no app`;
  return (
    <div className="max-h-96 overflow-y-auto p-3 text-sm">
      <div className="flex items-center justify-between pb-1">
        <span className="text-xs font-medium">Worktree ports</span>
        <span className="text-[11px] text-muted-foreground">{headline}</span>
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
              showHost={showHost}
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
