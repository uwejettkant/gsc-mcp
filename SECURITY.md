# Security Policy

`gsc-mcp` reads Google Search Console credentials from the local filesystem and exposes read-only Search Console queries to MCP clients over `stdio`. Because a flaw could expose service-account credentials or widen access beyond the intended read-only scope, security reports are welcome.

## Reporting a vulnerability

Please do not open a public GitHub issue for a security problem. Use GitHub's private vulnerability reporting instead: on the repository page, go to **Security** and choose **Report a vulnerability**.

Helpful details to include:

- the commit hash or version, your operating system, and your Node.js version,
- what you configured or ran and what happened,
- what you expected instead.

Please give the maintainer a reasonable window to publish a fix before disclosing the issue publicly.

## Scope

In scope, for example:

- any code path that requests or accepts a Google OAuth scope wider than `https://www.googleapis.com/auth/webmasters.readonly`,
- credential file contents, private keys, or tokens leaked into tool responses, error messages, or stderr logs,
- path handling around `GSC_CREDENTIALS_PATH` that reads unintended files or follows unsafe links,
- dependencies with known vulnerabilities reachable at runtime.
