import { describe, expect, it } from "vitest";
import { roleFor, serviceNameFor } from "../src/roles";

const base = { address: "0.0.0.0", source: "process" as const, processName: "node", label: null };

describe("roleFor", () => {
  it("treats a labelled port as the app whatever else it looks like", () => {
    expect(roleFor({ ...base, port: 5432, source: "docker", label: "DB UI" })).toBe("app");
  });

  it("treats every docker published port as a service", () => {
    expect(roleFor({ ...base, port: 3000, source: "docker" })).toBe("service");
  });

  it("recognises backing services by process name or well-known port", () => {
    expect(roleFor({ ...base, port: 15000, processName: "postgres" })).toBe("service");
    expect(roleFor({ ...base, port: 6379, processName: "java" })).toBe("service");
  });

  it("hides a loopback listener on an ephemeral port as internal", () => {
    expect(roleFor({ ...base, port: 63493, address: "127.0.0.1", processName: "claude" })).toBe("internal");
    expect(roleFor({ ...base, port: 50061, address: "::1", processName: "2.1.267" })).toBe("internal");
  });

  it("leaves a loopback dev server on a chosen port as the app", () => {
    expect(roleFor({ ...base, port: 5173, address: "127.0.0.1", processName: "node" })).toBe("app");
    expect(roleFor({ ...base, port: 8080, processName: "anton" })).toBe("app");
  });
});

describe("serviceNameFor", () => {
  it("prefers the compose service, then the well-known port, then the process", () => {
    expect(serviceNameFor({ port: 5432, source: "docker", processName: "docker", container: "x-postgres-1", service: "postgres" })).toBe("postgres");
    expect(serviceNameFor({ port: 5432, source: "docker", processName: "docker", container: "x-postgres-1", service: null })).toBe("x-postgres-1");
    expect(serviceNameFor({ port: 6379, source: "process", processName: "java", container: null, service: null })).toBe("redis");
    expect(serviceNameFor({ port: 4000, source: "process", processName: "mongod", container: null, service: null })).toBe("mongod");
  });
});
