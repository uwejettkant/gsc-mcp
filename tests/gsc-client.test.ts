import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatGscError,
  loadServiceAccountCredentials,
  READONLY_SCOPE,
  resetClientCache,
  resolveCredentialsPath,
  validateCredentialsFile,
} from "../src/gsc-client.js";

describe("gsc-client", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    resetClientCache();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gsc-mcp-test-"));
    tempDirs.push(dir);
    return dir;
  }

  it("pins the Google OAuth scope strictly to webmasters.readonly", () => {
    expect(READONLY_SCOPE).toBe("https://www.googleapis.com/auth/webmasters.readonly");
  });

  it("resolves default and tilde-prefixed credential paths", () => {
    expect(resolveCredentialsPath({}, "/home/alice")).toBe(
      "/home/alice/.config/gsc/service-account.json"
    );
    expect(
      resolveCredentialsPath({ GSC_CREDENTIALS_PATH: "  ~/secrets/sa.json  " }, "/home/alice")
    ).toBe("/home/alice/secrets/sa.json");
    expect(resolveCredentialsPath({ GSC_CREDENTIALS_PATH: "~" }, "/home/alice")).toBe(
      "/home/alice"
    );
  });

  it("rejects missing paths and directories when validating credentials", () => {
    const dir = makeTempDir();
    expect(() => validateCredentialsFile(path.join(dir, "missing.json"))).toThrow(
      /credentials file not found/
    );
    expect(() => validateCredentialsFile(dir)).toThrow(/not a regular file/);
  });

  it("warns once on POSIX when credentials file permissions are wider than 0600", () => {
    const dir = makeTempDir();
    const keyFile = path.join(dir, "service-account.json");
    fs.writeFileSync(keyFile, "{}", { mode: 0o644 });
    fs.chmodSync(keyFile, 0o644);

    const warn = vi.fn();
    validateCredentialsFile(keyFile, warn, "darwin");
    validateCredentialsFile(keyFile, warn, "darwin");

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/chmod 600/);
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

  it("loads only service_account JSON credentials and rejects external_account types without leaking contents", () => {
    const dir = makeTempDir();
    const validKey = path.join(dir, "valid.json");
    fs.writeFileSync(
      validKey,
      JSON.stringify({
        type: "service_account",
        client_email: "gsc-reader@example-project.iam.gserviceaccount.com",
        private_key: "test-only-placeholder-key",
      })
    );
    expect(loadServiceAccountCredentials(validKey)).toEqual({
      client_email: "gsc-reader@example-project.iam.gserviceaccount.com",
      private_key: "test-only-placeholder-key",
    });

    const externalAccount = path.join(dir, "external.json");
    fs.writeFileSync(
      externalAccount,
      JSON.stringify({
        type: "external_account",
        credential_source: { executable: { command: "/bin/sh" } },
      })
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
      })
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
