import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { auth, searchconsole, type searchconsole_v1 } from "@googleapis/searchconsole";

export const READONLY_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";

export type SearchConsoleClient = searchconsole_v1.Searchconsole;

let cachedClient: SearchConsoleClient | null = null;
let cachedCredentialsPath: string | null = null;
const warnedPaths = new Set<string>();

/**
 * Resolves the service-account JSON path from GSC_CREDENTIALS_PATH or defaults
 * to ~/.config/gsc/service-account.json.
 */
export function resolveCredentialsPath(
  env: NodeJS.ProcessEnv = process.env,
  homedir: string = os.homedir()
): string {
  const raw = env.GSC_CREDENTIALS_PATH?.trim();
  if (!raw) {
    return path.join(homedir, ".config", "gsc", "service-account.json");
  }
  if (raw === "~") {
    return homedir;
  }
  if (raw.startsWith("~/")) {
    return path.join(homedir, raw.slice(2));
  }
  return path.resolve(raw);
}

/**
 * Verifies that the credentials path points to an existing regular file and
 * warns on stderr if group/other permissions are open on POSIX systems.
 */
export function validateCredentialsFile(
  credentialsPath: string,
  warn: (message: string) => void = console.error,
  platform: NodeJS.Platform = process.platform
): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(credentialsPath);
  } catch {
    throw new Error(
      `GSC credentials file not found at "${credentialsPath}". ` +
        `Set GSC_CREDENTIALS_PATH or place your service-account JSON at ~/.config/gsc/service-account.json.`
    );
  }

  if (!stat.isFile()) {
    throw new Error(`GSC credentials path "${credentialsPath}" is not a regular file.`);
  }

  if (platform !== "win32" && (stat.mode & 0o077) !== 0 && !warnedPaths.has(credentialsPath)) {
    warnedPaths.add(credentialsPath);
    const octalMode = (stat.mode & 0o777).toString(8).padStart(3, "0");
    warn(
      `[gsc-mcp] Warning: credentials file "${credentialsPath}" has permissions ${octalMode}. ` +
        `Run "chmod 600 ${credentialsPath}" to restrict access to your user account.`
    );
  }
}

export interface ServiceAccountCredentials {
  client_email: string;
  private_key: string;
}

/**
 * Reads and validates that the credentials file is specifically a Google
 * `service_account` key (preventing `external_account` credential-sourcing
 * vectors and avoiding the deprecated `keyFile`/`keyFilename` option).
 * Never includes secret values in thrown error messages.
 */
export function loadServiceAccountCredentials(credentialsPath: string): ServiceAccountCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
  } catch {
    throw new Error(`GSC credentials file at "${credentialsPath}" is not valid JSON.`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`GSC credentials file at "${credentialsPath}" must contain a JSON object.`);
  }

  const record = parsed as Record<string, unknown>;
  if (record.type !== "service_account") {
    throw new Error(
      `Unsupported credential type in "${credentialsPath}". Expected "type": "service_account".`
    );
  }

  if (
    typeof record.client_email !== "string" ||
    !record.client_email.trim() ||
    typeof record.private_key !== "string" ||
    !record.private_key.trim()
  ) {
    throw new Error(
      `GSC service-account file at "${credentialsPath}" is missing required "client_email" or "private_key" fields.`
    );
  }

  return {
    client_email: record.client_email,
    private_key: record.private_key,
  };
}

/**
 * Clears the cached Search Console client (used in tests).
 */
export function resetClientCache(): void {
  cachedClient = null;
  cachedCredentialsPath = null;
  warnedPaths.clear();
}

/**
 * Returns a cached, strictly read-only Google Search Console API client.
 */
export function getSearchConsoleClient(): SearchConsoleClient {
  const credentialsPath = resolveCredentialsPath();

  if (cachedClient && cachedCredentialsPath === credentialsPath) {
    return cachedClient;
  }

  validateCredentialsFile(credentialsPath);
  const credentials = loadServiceAccountCredentials(credentialsPath);

  const jwtClient = new auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: [READONLY_SCOPE],
  });

  cachedClient = searchconsole({
    version: "v1",
    auth: jwtClient,
  });
  cachedCredentialsPath = credentialsPath;

  return cachedClient;
}

/**
 * Formats Google API and runtime errors into concise, actionable messages
 * without leaking internal stack traces or credential payloads.
 */
export function formatGscError(error: unknown): string {
  if (error && typeof error === "object") {
    const errObj = error as {
      message?: string;
      code?: number | string;
      errors?: Array<{ message?: string; reason?: string }>;
      response?: { status?: number; data?: { error?: { message?: string } } };
    };
    const apiMessage = errObj.response?.data?.error?.message ?? errObj.errors?.[0]?.message;
    const status = errObj.response?.status ?? errObj.code;
    if (apiMessage && status) {
      return `Google Search Console API error (${status}): ${apiMessage}`;
    }
    if (apiMessage) {
      return `Google Search Console API error: ${apiMessage}`;
    }
    if (errObj.message) {
      return errObj.message;
    }
  }
  return String(error);
}
