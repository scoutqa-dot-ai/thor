# Google Workspace

Thor installs [`@googleworkspace/cli`](https://github.com/googleworkspace/cli) **0.22.5** in remote-cli. The OpenCode `gws` command forwards to `/exec/gws`; it does not contain the upstream binary or Google credentials. A bundled `gws` skill covers finding Drive files, reading Docs (including tabs), and reading Sheets ranges.

## Configure a dedicated identity

1. In a Google Cloud project, enable the **Google Drive API**, **Google Docs API**, and **Google Sheets API**.
2. Create a dedicated service account and download its JSON key outside the repository. Do not grant domain-wide delegation. Share only the required files/folders or shared drives with the service account's `client_email`, as **Viewer**. A service account does not automatically see employees' My Drive files; Workspace sharing policies may require an administrator's involvement.
3. Install the key into the remote-cli-only mount. Container user `thor` is UID/GID **1001**:

   ```bash
   sudo install -d -m 700 -o 1001 -g 1001 docker-volumes/google-workspace
   sudo install -m 600 -o 1001 -g 1001 /secure/path/service-account.json \
     docker-volumes/google-workspace/credentials.json
   ```

4. Set in `.env`:

   ```dotenv
   GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/etc/thor/google-workspace/credentials.json
   GOOGLE_WORKSPACE_CLI_CONFIG_DIR=/var/lib/remote-cli/gws
   # Optional upstream project override:
   # GOOGLE_WORKSPACE_PROJECT_ID=your-project-id
   ```

5. Rebuild/recreate the two services:

   ```bash
   docker compose up --build -d remote-cli opencode
   docker compose exec opencode gws --version
   docker compose exec opencode gws drive files list \
     --params '{"pageSize":5,"fields":"files(id,name,mimeType)"}'
   ```

For a live content check, share a test Doc and Sheet with that identity, then run `gws docs documents get --params '{"documentId":"ID","includeTabsContent":true}'` and `gws sheets +read --spreadsheet ID --range 'Sheet1!A1:B2'` through `docker compose exec opencode`.

The integration is optional. With the credential variable unset, API reads return an actionable configuration error while help/schema remain available. Never place keys in `/workspace`, shared `/tmp`, agent memory, or a committed file. Vouch Google SSO credentials are unrelated and cannot authenticate this integration.

Workspace uses one global service identity, not profile-scoped credentials. Share only resources appropriate for all Thor sessions; do not use this integration for per-profile or per-user data isolation.

## Private storage and execution

- `./docker-volumes/google-workspace` is mounted **read-only into remote-cli only**, at `/etc/thor/google-workspace`.
- The config directory is created with mode 0700 and contains upstream config, token cache, and discovery cache. Its default location is in the remote-cli container layer; recreating the container clears caches, not the mounted key. If persistence is needed, use a dedicated remote-cli-only volume with UID 1001 ownership, never a shared agent volume.
- `GOOGLE_WORKSPACE_CLI_CONFIG_DIR` must be an absolute, private writable path with trusted ancestors. It is also the subprocess cwd because upstream searches cwd/ancestors for `.env`. Request cwd is ignored.
- The child receives only the selected Google configuration, PATH, and a private HOME—not unrelated Thor secrets or ambient OAuth tokens. It uses direct outbound HTTPS for Google discovery, OAuth token exchange, and APIs.
- Rotate keys by replacing the mounted file, clearing the private token cache, and recreating remote-cli. Do not print/export credentials through agent tools.

## Read policy

The exact method/flag allowlist lives in `packages/remote-cli/src/policy-gws.ts`; supported forms are described in the bundled skill. Reads return JSON (NDJSON for auto-pagination, capped at 10 pages per call). Writes, auth commands, unlisted services, file input/output, media downloads, Drive exports, dry-run, and sanitization are denied before spawning gws. Upstream help can describe commands beyond Thor's permitted surface; help is not permission.

Upstream chooses OAuth scopes from discovery and may request broad scopes even for read methods. The read-only boundary is Thor's exact command allowlist plus Google resource Viewer permissions, not an assumed read-only OAuth scope. Calendar, Gmail, per-user OAuth, and impersonation are not part of this integration.

Audit events contain the allowlisted operation, status/exit code, and session/call correlation—not queries, raw argv, document bodies, or credentials. Normal command output still reaches the agent/session, so restrict sharing to data Thor is authorized to use.

## Troubleshooting and verification

- **503 / exit 2:** missing configuration, inaccessible key, or private-directory permissions. Check paths and UID 1001 access without printing the key.
- **Google 403:** enable the API or correct service-account sharing/Workspace policy. **404:** check the file ID and identity access. Drive search returning no files may simply mean nothing has been shared.
- **Discovery errors:** allow outbound HTTPS to Google's discovery/API hosts; clear stale private discovery cache after an upstream upgrade.
- **Policy denial:** use the supported read forms; do not try an alternate binary or credentials.

`pnpm test` covers policy and real HTTP/subprocess behavior without Google credentials. `scripts/test-gws-e2e.sh` exercises the pinned CLI and OpenCode wrapper with local discovery/API fixtures; Core E2E runs it as an isolated container check. Live Google access remains an operator post-deployment check using the commands above.
