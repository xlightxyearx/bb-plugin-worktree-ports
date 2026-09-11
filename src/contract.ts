// Shared between server.ts (which orchestrates) and host.ts (which scans).
// Every field crossing the host RPC boundary is validated by these schemas.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** One worktree the scanner should attribute listeners to. */
export const portRootSchema = z.object({
  environmentId: z.string().min(1),
  path: z.string().min(1),
});
export type PortRoot = z.infer<typeof portRootSchema>;

export const scannedPortSchema = z.object({
  environmentId: z.string(),
  port: z.number().int().min(1).max(65535),
  address: z.string(),
  /** The listening process, or the Docker proxy for a published container port. */
  pid: z.number().int(),
  processName: z.string(),
  source: z.enum(["process", "docker"]),
  /** Container name for docker-sourced rows; null otherwise. */
  container: z.string().nullable(),
  /** Compose service name (`postgres`, `redis`) for docker rows; null otherwise. */
  service: z.string().nullable(),
  /** What the port is for: the app under development, a backing service, or
   *  an internal loopback listener nobody opens in a browser. */
  role: z.enum(["app", "service", "internal"]),
  /** Friendly name from the worktree's ports.json, when it names this port. */
  label: z.string().nullable(),
  /** Scheme declared in ports.json; null leaves the choice to a heuristic. */
  scheme: z.enum(["http", "https"]).nullable(),
});
export type ScannedPort = z.infer<typeof scannedPortSchema>;

export const scanInputSchema = z.object({
  roots: z.array(portRootSchema).max(200),
  includeDocker: z.boolean(),
  ignorePorts: z.array(z.number().int().min(1).max(65535)).max(200),
  ignoreProcesses: z.array(z.string()).max(200),
});

export const hostContract = defineRpcContract({
  scan: {
    input: scanInputSchema,
    output: z.object({
      ports: z.array(scannedPortSchema),
      scannedAt: z.number(),
      /** Non-null when the docker pass failed; the process pass still stands. */
      dockerError: z.string().nullable(),
    }),
  },
  release: {
    input: z.object({
      environmentId: z.string().min(1),
      port: z.number().int().min(1).max(65535),
      roots: z.array(portRootSchema).max(200),
      includeDocker: z.boolean(),
    }),
    output: z.object({ released: z.boolean(), detail: z.string() }),
  },
});
