import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { apiProxy } from "./api-proxy.ts";

// The dev and preview servers send /api to a task service on the port the contract states — unless
// TASK_API points elsewhere, which the e2e smoke does, at the service check-contract started for it.
// Preview inherits this proxy, so the smoke drives the built app against the same target.
const proxy = process.env.TASK_API === undefined ? apiProxy : { "/api": process.env.TASK_API };

export default defineConfig({
  plugins: [react()],
  // The dev server forwards API calls to whichever task service runs on its default port.
  server: {
    proxy,
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.ts"],
  },
});
