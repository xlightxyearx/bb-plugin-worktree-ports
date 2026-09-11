# Worktree Ports

Shows what each BB worktree is serving, in the sidebar footer. Click a port
pill to open it.

## How ports are found

Discovery is live and needs no per-worktree configuration. On every scan the
host worker for each machine:

1. reads listening TCP sockets (`lsof -nP -iTCP -sTCP:LISTEN`),
2. resolves each listening process's working directory (`/proc/<pid>/cwd` on
   Linux, a second `lsof` pass on macOS) and attributes it to the worktree
   containing it — longest path match, so a nested chain worktree is its own,
3. attributes published Docker ports through the compose project's
   `com.docker.compose.project.working_dir` label, which is the only way a
   container's ports reach the worktree that started them,
4. labels what it found from the worktree's `ports.json`.

Attributing by working directory means a dev server that an agent started in
the background — reparented to PID 1, no controlling terminal — is still found.

## Surfaces

- **Sidebar footer** — a disclosure grouped by worktree: branch, thread, and
  one pill per port. Hovering a pill reveals a stop button.
- **Sidebar thread rows** — threads whose worktree has a listener get a glyph;
  its tooltip lists the ports. Turn off with the "Mark sidebar threads" setting.
- **`bb ports list [--json]`**, **`bb ports release <env-id> <port>`**.
- **`worktree_ports` agent tool** and the `worktree-ports` skill.

## Opening a port

A plain click follows the **Open ports in** setting: `BB browser preference`
hands the URL to BB, which honors whatever in-app/external preference that
client already has; `System browser` opens it outside BB. ⌘/Ctrl-click does
the other one. Forcing the *in-app* browser against a client whose preference
is external is not possible — BB owns that tab kind and exposes no API for it.

## Labels

Commit `.bb/ports.json` (or reuse an existing `.superset/ports.json`):

```json
{
  "ports": [
    { "port": 3000, "label": "Frontend" },
    { "port": 4443, "label": "API", "scheme": "https" }
  ]
}
```

Discovery stays authoritative: labels only name ports already listening,
entries for ports that are not listening are ignored, and a malformed file
labels nothing rather than hiding ports. Without an explicit `scheme`, ports in
the 443 family are assumed HTTPS.

## Settings

| Setting | Default | |
|---|---|---|
| Scan interval (seconds) | 3 | 1–60 |
| Include Docker published ports | on | |
| Ignore ports | — | comma separated |
| Ignore processes | — | comma separated, matched on the process name |
| Open ports in | BB browser preference | or System browser |
| Mark sidebar threads that have listening ports | on | |

## Limits

- macOS and Linux. The scanner needs `lsof`; Windows is not supported.
- Ports are listed for the machine each worktree lives on. A remote host's
  `localhost:PORT` is not forwarded to your machine — use `bb connect`, SSH, or
  Tailscale for that.
- Only processes visible to the daemon's user are attributed.

## Development

```bash
npm install --include=dev
npm test          # parsing and attribution
npm run typecheck
bb plugin build && bb plugin install . --yes
```
