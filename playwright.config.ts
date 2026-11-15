import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 45000,
  fullyParallel: false,
  use: {
    baseURL: "http://127.0.0.1:4329",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run start",
    url: "http://127.0.0.1:4329",
    reuseExistingServer: false,
    timeout: 60000,
    env: {
      PORT: "4329",
      CHARACTERIZE_DATA_DIR: "/private/tmp/characterize-e2e-data",
    },
  },
});
