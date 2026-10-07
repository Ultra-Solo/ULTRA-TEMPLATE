import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigError, DEVELOPMENT_VERSION, loadConfig, loadVersion } from "../src/config.ts";

test("the defaults are the ones the README documents", () => {
  assert.deepEqual(loadConfig({}), {
    apiBaseUrl: "http://localhost:8080/",
    requestTimeoutMs: 10_000,
    transport: "stdio",
    httpPort: 3000,
  });
});

test("a URL this service cannot call fails at startup instead of on every tool call", () => {
  assert.equal(loadConfig({ TASK_API_URL: "https://tasks.internal:8443" }).apiBaseUrl, "https://tasks.internal:8443/");
  assert.throws(() => loadConfig({ TASK_API_URL: "localhost:8080" }), ConfigError);
  assert.throws(() => loadConfig({ TASK_API_URL: "file:///etc/passwd" }), /must be http or https/);
});

test("the timeout is whole milliseconds, and nothing that merely looks like a number", () => {
  assert.equal(loadConfig({ TASK_API_TIMEOUT_MS: "250" }).requestTimeoutMs, 250);
  for (const bad of ["0", "-1", "2.5", "8e3", "0x10", " 250", ""]) {
    if (bad === "") continue;
    assert.throws(() => loadConfig({ TASK_API_TIMEOUT_MS: bad }), ConfigError, bad);
  }
  assert.equal(loadConfig({ TASK_API_TIMEOUT_MS: "" }).requestTimeoutMs, 10_000);
});

test("the transport is stdio or http, and nothing that merely looks like one", () => {
  assert.equal(loadConfig({ MCP_TRANSPORT: "" }).transport, "stdio");
  assert.equal(loadConfig({ MCP_TRANSPORT: "http" }).transport, "http");
  assert.equal(loadConfig({ MCP_TRANSPORT: "stdio" }).transport, "stdio");
  for (const bad of ["HTTP", "tcp", "https", "stdio ", " stdio"]) {
    assert.throws(() => loadConfig({ MCP_TRANSPORT: bad }), ConfigError, bad);
  }
});

test("the http port is a whole port number, and 0 asks the operating system for one", () => {
  assert.equal(loadConfig({ MCP_HTTP_PORT: "" }).httpPort, 3000);
  assert.equal(loadConfig({ MCP_HTTP_PORT: "3001" }).httpPort, 3001);
  assert.equal(loadConfig({ MCP_HTTP_PORT: "0" }).httpPort, 0);
  for (const bad of ["65536", "-1", "2.5", "8e3", "0x10", " 3000", "abc"]) {
    assert.throws(() => loadConfig({ MCP_HTTP_PORT: bad }), ConfigError, bad);
  }
});

test("the version is the release the image was built as, and a build that is not one says so", () => {
  assert.equal(loadVersion({}), DEVELOPMENT_VERSION);
  assert.equal(loadVersion({ MCP_SERVER_VERSION: "" }), DEVELOPMENT_VERSION);
  assert.equal(loadVersion({ MCP_SERVER_VERSION: "1.2.0" }), "1.2.0");
  assert.equal(loadVersion({ MCP_SERVER_VERSION: "1.2.0-rc.1+build.5" }), "1.2.0-rc.1+build.5");
  for (const bad of ["v1.2.0", "1.2", "latest", "01.2.0", " 1.2.0"])
    assert.throws(() => loadVersion({ MCP_SERVER_VERSION: bad }), ConfigError, bad);
});
