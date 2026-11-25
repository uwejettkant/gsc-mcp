# gsc-mcp

Minimal, strictly **read-only** local [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server for **Google Search Console**, written in TypeScript (~960 lines across four files).

## Why a pinned local build instead of `npx ...@latest`?

Connecting Google Search Console to a coding agent requires a Google Cloud service-account key. Passing that key into an unpinned package via `npx -y ...@latest` downloads and executes whatever was pushed to the registry most recently—inside the same process that holds your credentials—on every session start.

**To anyone else reading this on GitHub, this repository is third-party code too—so do not run it blindly either.** For read-only Search Console reporting, the entire API surface is three endpoints (`sites.list`, `searchanalytics.query`, `urlInspection.index.inspect`). Keeping the server deliberately small (four files in [`src/`](./src), three runtime dependencies, `ignore-scripts=true`) means you can read the full source in a few minutes—especially [`src/gsc-client.ts`](./src/gsc-client.ts), where the key is loaded and the OAuth scope is pinned—before building a fixed commit locally, forking it, or using it as a blueprint to write your own. Once built, nothing updates behind your back.

## Security Model (Defense in Depth)

1. **Hardcoded read-only OAuth scope:** [`src/gsc-client.ts`](./src/gsc-client.ts) pins `https://www.googleapis.com/auth/webmasters.readonly`. Sitemaps cannot be deleted, URLs cannot be removed, and settings cannot be modified—even under prompt injection.
2. **Property-level least privilege:** The service account only sees Search Console properties where you explicitly add its email address with **Restricted** (`siteRestrictedUser`) permission.
3. **Local key isolation:** Credentials live outside every Git repository at `~/.config/gsc/service-account.json` (`chmod 600`; startup warns on `stderr` if group/world-readable). Install scripts are disabled via `.npmrc` (`ignore-scripts=true`), and `@googleapis/searchconsole` is used instead of the monolithic `googleapis` package.

## Provided MCP Tools

All tools carry MCP `readOnlyHint: true` and `destructiveHint: false` annotations:

| Tool | Purpose |
| :--- | :--- |
| `gsc_list_sites` | Lists all Search Console properties granted to the service account (`siteUrl` and `permissionLevel`). |
| `gsc_search_analytics` | Queries `clicks`, `impressions`, `ctrPercent`, and `position` grouped by `query`, `page`, `country`, `device`, `searchAppearance`, or `date`, with AND-filters, pagination (`rowLimit`, `startRow`), `searchType`, and sorting (`clicks`, `impressions`, `ctr`, `position`). Defaults to the last 28 days shifted back by GSC's 3-day data lag. |
| `gsc_compare_periods` | Compares two equal-length periods (e.g., last 28 or 90 days vs. preceding period) and returns property-wide deltas plus top winners and losers (`clicksDiff`, `impressionsDiff`, `positionDiff`) with optional `minImpressions` noise filtering. Queries ungrouped property totals alongside dimension rows so Google's privacy-thresholded `query` breakdowns never undercount total site clicks. |
| `gsc_inspect_url` | Runs the URL Inspection API for a specific URL: indexing verdict, coverage state, `lastCrawlTime`, `crawledAs`, `googleCanonical` vs. `userCanonical`, `robotsTxtState`, sitemaps, mobile usability, and rich results. |

## Setup in 5 Minutes

### 1. Create a read-only Google Cloud service account

Using the [Google Cloud CLI (`gcloud`)](https://cloud.google.com/sdk/docs/install):

```bash
export GCP_PROJECT="my-gsc-mcp-project"
export SA_NAME="gsc-reader"
export SA_EMAIL="${SA_NAME}@${GCP_PROJECT}.iam.gserviceaccount.com"

# Create a dedicated project (or skip if using an existing project)
gcloud projects create "$GCP_PROJECT" --name="GSC Read-Only MCP"
gcloud config set project "$GCP_PROJECT"

# Enable the Google Search Console API
gcloud services enable searchconsole.googleapis.com

# Create the service account (no IAM project roles needed)
gcloud iam service-accounts create "$SA_NAME" \
  --display-name="Search Console Read-Only MCP"

# Export the key outside your repositories and lock down permissions
mkdir -p ~/.config/gsc
chmod 700 ~/.config/gsc
gcloud iam service-accounts keys create ~/.config/gsc/service-account.json \
  --iam-account="$SA_EMAIL"
chmod 600 ~/.config/gsc/service-account.json
```

### 2. Grant property access in Google Search Console

Repeat this 30-second step for each property you want to query:

1. Open [Google Search Console](https://search.google.com/search-console) and select your property (e.g., `example.com`).
2. Go to **Settings -> Users and permissions -> Add user**.
3. Enter your service-account email (`gsc-reader@my-gsc-mcp-project.iam.gserviceaccount.com`) with permission **Restricted**.

The property becomes immediately visible to `gsc_list_sites`.

### 3. Inspect, verify, and build locally

Requires **Node.js 22+** (Node 24 LTS recommended). Read through [`src/`](./src) first (start with [`src/gsc-client.ts`](./src/gsc-client.ts)), then install and build a pinned commit:

```bash
git clone https://github.com/uwejettkant/gsc-mcp.git
cd gsc-mcp
npm ci
npm run check
```

### 4. Register in your coding agent

#### Claude Code

```bash
claude mcp add gsc-mcp --scope user -- node /absolute/path/to/gsc-mcp/dist/index.js
```

#### Google Antigravity / Claude Desktop / Cursor (`mcp_config.json`)

```json
{
  "mcpServers": {
    "gsc-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/gsc-mcp/dist/index.js"]
    }
  }
}
```

If you store the key somewhere other than `~/.config/gsc/service-account.json`, pass `GSC_CREDENTIALS_PATH` via `"env"`:

```json
{
  "mcpServers": {
    "gsc-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/gsc-mcp/dist/index.js"],
      "env": {
        "GSC_CREDENTIALS_PATH": "~/.config/gsc/custom-key.json"
      }
    }
  }
}
```

## Development & Verification

```bash
npm run check       # Typecheck (src + tests), Vitest suite, and TypeScript build
npm test            # Run unit and in-memory MCP protocol tests
npm run typecheck   # Strict TypeScript check without emitting files
npm run build       # Compile TypeScript into dist/
```

## License

[MIT](./LICENSE) © Uwe Jettkant
