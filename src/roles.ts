// Which ports deserve attention. An "app" is what the operator is developing;
// a "service" is a backing store it talks to; "internal" is a loopback
// listener on an ephemeral port that no one opens in a browser.
import type { ScannedPort } from "./contract";

export type PortRole = ScannedPort["role"];

/** Common backing services run outside Docker, matched on the lsof COMMAND. */
const SERVICE_PROCESSES = new Set([
  "postgres",
  "postmaster",
  "redis-server",
  "redis-serv",
  "mongod",
  "mysqld",
  "mariadbd",
  "memcached",
  "mailpit",
  "nats-server",
  "etcd",
  "minio",
  "clickhouse",
  "beam.smp",
]);

/** Well-known service ports, used when the process name says nothing. */
const SERVICE_PORTS = new Map<number, string>([
  [5432, "postgres"],
  [3306, "mysql"],
  [6379, "redis"],
  [27017, "mongodb"],
  [7474, "neo4j"],
  [7687, "neo4j"],
  [9200, "elasticsearch"],
  [5672, "amqp"],
  [15672, "rabbitmq"],
  [1025, "smtp"],
  [8025, "mailpit"],
  [11211, "memcached"],
  [4222, "nats"],
  [2379, "etcd"],
  [9092, "kafka"],
  [2181, "zookeeper"],
]);

/** The IANA dynamic range, where nothing chooses its own port. */
const EPHEMERAL_FROM = 49152;

function isLoopback(address: string): boolean {
  return address.startsWith("127.") || address === "::1";
}

export function roleFor(
  port: Pick<ScannedPort, "port" | "address" | "source" | "processName" | "label">,
): PortRole {
  // A ports.json label is the operator saying "this one matters".
  if (port.label !== null) return "app";
  if (port.source === "docker") return "service";
  if (SERVICE_PROCESSES.has(port.processName.toLowerCase())) return "service";
  if (SERVICE_PORTS.has(port.port)) return "service";
  if (isLoopback(port.address) && port.port >= EPHEMERAL_FROM) return "internal";
  return "app";
}

/** A short name for a service pill: compose service, else the well-known port. */
export function serviceNameFor(
  port: Pick<ScannedPort, "port" | "source" | "processName" | "container" | "service">,
): string {
  if (port.service !== null) return port.service;
  if (port.source === "docker") return port.container ?? "docker";
  return SERVICE_PORTS.get(port.port) ?? port.processName;
}

const ROLE_RANK: Record<PortRole, number> = { app: 0, service: 1, internal: 2 };

export function compareByRole(left: ScannedPort, right: ScannedPort): number {
  return ROLE_RANK[left.role] - ROLE_RANK[right.role] || left.port - right.port;
}
