# AGENTS.md — rules for coding agents working on gsc-mcp

> **One source for every agent.** This file applies to every coding agent (Claude Code, Antigravity, Codex, Cursor …). `.claude/CLAUDE.md` only imports it. Update rules here, nowhere else.

## 1. What this is

`gsc-mcp` is a minimal, strictly read-only Model Context Protocol (MCP) server for Google Search Console over `stdio`. It is kept small enough to inspect in full before building a pinned commit locally (or using it as a blueprint), so Google service-account credentials never pass through unpinned `npx @latest` auto-updates.

## 2. Non-negotiable safety invariants

Every invariant below is backed by unit or protocol tests in `tests/`. If a change breaks one of those tests, the change is wrong, not the test.

1. **Strictly read-only OAuth scope:** `READONLY_SCOPE` in `src/gsc-client.ts` must remain `https://www.googleapis.com/auth/webmasters.readonly`. Never request `https://www.googleapis.com/auth/webmasters` or add mutating tools (such as submitting/deleting sitemaps or requesting URL removals).
2. **Read-only tool annotations:** Every registered MCP tool must carry `readOnlyHint: true` and `destructiveHint: false`.
3. **Zero credential leakage:** Never read, print, or include service-account JSON contents, private keys, or tokens in tool responses, error messages, logs, tests, or commits. On POSIX systems, warn on `stderr` if the credentials file has group/world permissions (`mode & 0o077`).
4. **Placeholder domains only:** All tool descriptions, examples, tests, and documentation in this repository must use RFC 2606 placeholders (`example.com`, `sc-domain:example.com`, `your-project-id`). Never commit real user or client domains, project IDs, or service-account email addresses.
5. **Minimal dependency surface:** Keep runtime dependencies limited to `@modelcontextprotocol/sdk`, `@googleapis/searchconsole`, and `zod`. Do not install the monolithic `googleapis` package.
6. **Quality gate before every commit:** Run `npm run check` (`typecheck`, `vitest run`, `tsc` build) and `npm audit`. Every new test covering a bug or safety rule must be verified once via mutation (temporarily break the guarded line in `src/` and confirm the test turns red).
7. **Git and publishing:** Use Conventional Commits on feature/fix branches. Never run `git push`, create tags/releases, or run `npm publish` without the maintainer's explicit approval.

## 3. Commands

Node 22+ at runtime (`.nvmrc` pins Node 24 LTS for CI and local development).

```bash
npm run check       # typecheck (src + tests), vitest run, tsc build — the gate
npm run typecheck   # tsc --noEmit for src/ and tests/
npm test            # vitest run
npm run test:watch  # vitest watch mode
npm run build       # compiles src/ -> dist/
npm start           # runs node dist/index.js on stdio
```

## 4. Architecture

| File | Responsibility |
| :--- | :--- |
| `src/index.ts` | CLI entry point (`#!/usr/bin/env node`): runs a non-fatal startup permission check and connects `createGscServer()` to `StdioServerTransport`. |
| `src/server.ts` | `createGscServer` plus pure formatting, sorting, and period-comparison helpers. `gsc_compare_periods` queries ungrouped property totals alongside dimension rows so Google's privacy thresholding on `query` rows never undercounts site clicks/impressions, and skips one-sided truncated keys when `fetchLimit` is reached. |
| `src/gsc-client.ts` | Resolves `GSC_CREDENTIALS_PATH` (default `~/.config/gsc/service-account.json`), rejects symlinks and oversized files via `lstatSync` + `O_NOFOLLOW`, checks POSIX `0600` permissions, caches the read-only Search Console v1 client, and formats API errors cleanly. |
| `src/date-utils.ts` | Strict UTC `YYYY-MM-DD` validation (rejecting calendar rollovers like `2026-02-31`), 3-day GSC lag defaults, and single/comparison period resolution. |
| `tests/*.test.ts` | Unit tests and end-to-end MCP protocol tests over `InMemoryTransport` with mocked Search Console clients (no network or real credentials required). |
