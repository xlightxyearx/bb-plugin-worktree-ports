---
name: worktree-ports
description: Find which TCP ports are listening in a BB workspace (worktree) and which process or container owns them. Use when asked what is running in a worktree, which port a dev server is on, what URL reaches a running app, or to stop whatever holds a port.
---

# Worktree ports

Port discovery is live: the plugin scans listening sockets on each machine and
attributes them to a worktree by the listening process's working directory, or
for Docker by the compose project's working directory. Nothing is configured
per worktree — a server that is up is listed, a server that is down is not.

## Read the ports

```bash
bb ports list           # grouped by worktree, with URLs
bb ports list --json    # same data for scripting
```

The `worktree_ports` agent tool returns the same listing, and takes an optional
`environmentId` (`env_*`) to scope it to one worktree.

## Stop a server

```bash
bb ports release <environment-id> <port>
```

The target is resolved by a fresh scan, so this can only stop something the
plugin currently attributes to that worktree: a process gets `SIGTERM`, a
published container port stops its container.

## Label ports for a repo

Commit `.bb/ports.json` in the repository to name ports in the UI. An existing
`.superset/ports.json` is read as a fallback, so a repo already labelled for
Superset needs no second file.

```json
{
  "ports": [
    { "port": 3000, "label": "Frontend" },
    { "port": 4443, "label": "API", "scheme": "https" }
  ]
}
```

Discovery stays authoritative: labels only name ports that are already
listening, entries for ports that are not listening are ignored, and a
malformed file labels nothing rather than hiding the ports.
