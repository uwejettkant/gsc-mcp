import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkCredentialsPermissionsOnStartup,
  formatGscError,
  getSearchConsoleClient,
  loadServiceAccountCredentials,
  MAX_CREDENTIALS_FILE_BYTES,
  READONLY_SCOPE,
  resetClientCache,
  resolveCredentialsPath,
  validateCredentialsFile,
} from "../src/gsc-client.js";

describe("gsc-client", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    resetClientCache();
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gsc-mcp-test-"));
    tempDirs.push(dir);
    return dir;
  }

  it("pins READONLY_SCOPE and wires getSearchConsoleClient strictly to webmasters.readonly", () => {
    expect(READONLY_SCOPE).toBe("https://www.googleapis.com/auth/webmasters.readonly");

    const dir = makeTempDir();
    const keyFile = path.join(dir, "service-account.json");
    fs.writeFileSync(
      keyFile,
      JSON.stringify({
        type: "service_account",
        client_email: "gsc-reader@your-project-id.iam.gserviceaccount.com",
        private_key: "test-only-placeholder-key",
      }),
      { mode: 0o644 }
    );
    fs.chmodSync(keyFile, 0o644);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const env = { GSC_CREDENTIALS_PATH: keyFile };

    const client1 = getSearchConsoleClient(env, dir);
    const client2 = getSearchConsoleClient(env, dir);
    expect(client1).toBe(client2);

    const jwtAuth = (
      client1 as unknown as {
        context: { _options: { auth: { email?: string; scopes?: string[] } } };
      }
    ).context._options.auth;

    expect(jwtAuth.email).toBe("gsc-reader@your-project-id.iam.gserviceaccount.com");
    expect(jwtAuth.scopes).toEqual(["https://www.googleapis.com/auth/webmasters.readonly"]);

    if (process.platform !== "win32") {
      expect(errSpy).toHaveBeenCalledTimes(1);
      expect(errSpy.mock.calls[0]?.[0]).toMatch(/chmod 600/);
    }
  });

  it("resolves default, tilde-prefixed, and relative credential paths", () => {
    expect(resolveCredentialsPath({}, "/home/alice")).toBe(
      "/home/alice/.config/gsc/service-account.json"
    );
    expect(
      resolveCredentialsPath({ GSC_CREDENTIALS_PATH: "  ~/secrets/sa.json  " }, "/home/alice")
    ).toBe("/home/alice/secrets/sa.json");
    expect(resolveCredentialsPath({ GSC_CREDENTIALS_PATH: "~" }, "/home/alice")).toBe(
      "/home/alice"
    );
    expect(
      resolveCredentialsPath({ GSC_CREDENTIALS_PATH: "./local-sa.json" }, "/home/alice")
    ).toBe(path.resolve("./local-sa.json"));
  });

  it("rejects missing paths, directories, symlinks, and oversized files", () => {
    const dir = makeTempDir();
    expect(() => validateCredentialsFile(path.join(dir, "missing.json"))).toThrow(
      /credentials file not found/
    );
    expect(() => validateCredentialsFile(dir)).toThrow(/not a regular file/);

    const targetFile = path.join(dir, "real.json");
    fs.writeFileSync(
      targetFile,
      JSON.stringify({
        type: "service_account",
        client_email: "gsc-reader@your-project-id.iam.gserviceaccount.com",
        private_key: "test-only-placeholder-key",
      }),
      { mode: 0o600 }
    );
    const linkFile = path.join(dir, "symlink.json");
    fs.symlinkSync(targetFile, linkFile);

    expect(() => validateCredentialsFile(linkFile)).toThrow(/must not be a symbolic link/);
    expect(() => loadServiceAccountCredentials(linkFile)).toThrow(/must not be a symbolic link/);

    const hugeFile = path.join(dir, "huge.json");
    fs.writeFileSync(hugeFile, "x".repeat(MAX_CREDENTIALS_FILE_BYTES + 16), { mode: 0o600 });
    expect(() => validateCredentialsFile(hugeFile)).toThrow(/exceeds maximum allowed size/);
    expect(() => loadServiceAccountCredentials(hugeFile)).toThrow(/exceeds maximum allowed size/);
  });

  it("warns once on POSIX when credentials file permissions are wider than 0600 including at startup", () => {
    const dir = makeTempDir();
    const keyFile = path.join(dir, "service-account.json");
    fs.writeFileSync(keyFile, "{}", { mode: 0o644 });
    fs.chmodSync(keyFile, 0o644);

    const warn = vi.fn();
    checkCredentialsPermissionsOnStartup({ GSC_CREDENTIALS_PATH: keyFile }, dir, warn, "darwin");
    validateCredentialsFile(keyFile, warn, "darwin");

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/chmod 600/);

    // Non-existent path at startup must not throw so `tools/list` still works pre-setup
    expect(() =>
      checkCredentialsPermissionsOnStartup(
        { GSC_CREDENTIALS_PATH: path.join(dir, "not-created-yet.json") },
        dir,
        warn,
        "darwin"
      )
    ).not.toThrow();
  });

  it("does not warn when credentials file has mode 0600", () => {
    const dir = makeTempDir();
    const keyFile = path.join(dir, "service-account.json");
    fs.writeFileSync(keyFile, "{}", { mode: 0o600 });
    fs.chmodSync(keyFile, 0o600);

    const warn = vi.fn();
    validateCredentialsFile(keyFile, warn, "darwin");
    expect(warn).not.toHaveBeenCalled();
  });

  it("loads only service_account JSON objects and rejects arrays, invalid JSON, and external_account without leaking contents", () => {
    const dir = makeTempDir();
    const validKey = path.join(dir, "valid.json");
    fs.writeFileSync(
      validKey,
      JSON.stringify({
        type: "service_account",
        client_email: "gsc-reader@your-project-id.iam.gserviceaccount.com",
        private_key: "test-only-placeholder-key",
      }),
      { mode: 0o600 }
    );
    expect(loadServiceAccountCredentials(validKey)).toEqual({
      client_email: "gsc-reader@your-project-id.iam.gserviceaccount.com",
      private_key: "test-only-placeholder-key",
    });

    const arrayFile = path.join(dir, "array.json");
    fs.writeFileSync(arrayFile, "[]", { mode: 0o600 });
    expect(() => loadServiceAccountCredentials(arrayFile)).toThrow(/must contain a JSON object/);

    const malformedFile = path.join(dir, "malformed.json");
    fs.writeFileSync(malformedFile, '{ "private_key": "RAW_SECRET_IN_SYNTAX_ERROR"', {
      mode: 0o600,
    });
    try {
      loadServiceAccountCredentials(malformedFile);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(String(err)).toMatch(/is not valid JSON/);
      expect(String(err)).not.toContain("RAW_SECRET_IN_SYNTAX_ERROR");
    }

    const externalAccount = path.join(dir, "external.json");
    fs.writeFileSync(
      externalAccount,
      JSON.stringify({
        type: "external_account",
        credential_source: { executable: { command: "/bin/sh" } },
      }),
      { mode: 0o600 }
    );
    expect(() => loadServiceAccountCredentials(externalAccount)).toThrow(
      /Expected "type": "service_account"/
    );

    const incompleteKey = path.join(dir, "incomplete.json");
    fs.writeFileSync(
      incompleteKey,
      JSON.stringify({
        type: "service_account",
        private_key: "SUPER_SECRET_DO_NOT_LEAK",
      }),
      { mode: 0o600 }
    );
    try {
      loadServiceAccountCredentials(incompleteKey);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(String(err)).toMatch(/missing required/);
      expect(String(err)).not.toContain("SUPER_SECRET_DO_NOT_LEAK");
    }
  });

  it("formats structured Google API errors cleanly without leaking internals", () => {
    expect(
      formatGscError({
        response: {
          status: 403,
          data: { error: { message: "User does not have sufficient permission for site." } },
        },
      })
    ).toBe(
      "Google Search Console API error (403): User does not have sufficient permission for site."
    );

    expect(
      formatGscError({
        code: 400,
        errors: [{ message: "Invalid startDate" }],
      })
    ).toBe("Google Search Console API error (400): Invalid startDate");
  });
});
