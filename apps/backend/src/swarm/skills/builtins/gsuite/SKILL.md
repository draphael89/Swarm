---
name: gsuite
description: Google Workspace access via gog CLI (Gmail, Calendar, Drive, Docs). Supports read and write operations in v1.
env:
  - name: GOG_ACCOUNT
    description: Default Google account email for gog commands.
    required: false
  - name: GOG_KEYRING_BACKEND
    description: gog keyring backend (`auto` or `file`).
    required: false
  - name: GOG_KEYRING_PASSWORD
    description: Password used when `GOG_KEYRING_BACKEND=file`.
    required: false
  - name: GOG_CLIENT
    description: Optional OAuth client profile name.
    required: false
---

# G Suite (gog CLI)

Use this skill when you need Google Workspace actions from the terminal.

Important: this skill is documentation-only. Do not use wrapper scripts. Run `gog` directly.

## Install / Verify

`gog` must be installed on the host:

```bash
brew install steipete/tap/gog
```

Alternative: build from source at `https://github.com/steipete/gogcli`.

Verify install:

```bash
gog --version
gog --help
```

## CLI Help / Usage

Use these commands to discover supported operations:

```bash
gog --help
GOG_HELP=full gog --help
gog auth --help
gog gmail --help
gog calendar --help
gog drive --help
gog docs --help
```

Most commands support machine-readable output:

```bash
gog --json <group> <command> ...
```

Set default account globally or per command:

```bash
export GOG_ACCOUNT="you@company.com"
gog --account you@company.com <group> <command> ...
```

## OAuth Setup (from Swarm Settings)

Preferred flow is through Swarm Settings:

1. Paste OAuth client JSON.
2. Click **Connect Google**.
3. Open the auth URL.
4. Paste the redirect URL and complete.

Manual CLI equivalents:

```bash
# Save OAuth client credentials
gog auth credentials ./credentials.json
# or stdin
gog auth credentials - < ./credentials.json

# Start remote auth
gog --json auth add you@company.com --services gmail,calendar,drive,docs --remote --step 1

# Complete remote auth with redirect URL
gog --json auth add you@company.com --services gmail,calendar,drive,docs --remote --step 2 --auth-url '<full-redirect-url>'

# Check auth status
gog --json auth status --account you@company.com
```

## v1 Read + Write Examples

### Gmail

Read/search:

```bash
gog --json gmail messages list --account you@company.com --max 10
gog --json gmail messages get --account you@company.com --id <message-id>
```

Send:

```bash
gog --json gmail send --account you@company.com --to person@example.com --subject "Status" --body "Update..."
```

### Calendar

Read/list:

```bash
gog --json calendar events list --account you@company.com --calendar primary
```

Create event:

```bash
gog --json calendar events create --account you@company.com --calendar primary --title "Review" --start "2026-02-21T17:00:00Z" --end "2026-02-21T17:30:00Z"
```

### Drive

List/search:

```bash
gog --json drive files list --account you@company.com --limit 20
```

Upload:

```bash
gog --json drive files upload --account you@company.com --path ./report.pdf --name "report.pdf"
```

### Docs

```bash
gog --json docs documents get --account you@company.com --document-id <doc-id>
```

## Notes

- Keep write actions explicit and intentional.
- Prefer `--json` for reliable parsing.
- If a command fails, run `<group> --help` to verify the exact subcommand/flags for your installed gog version.
