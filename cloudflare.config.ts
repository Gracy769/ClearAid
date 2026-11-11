import { bindings, defineConfig, defineWorker } from "cf/config";

export default defineConfig({
  worker: defineWorker({
    name: "invoice-ready",
    entrypoint: "vinext/server/fetch-handler",
    compatibilityDate: "2026-11-03",
    compatibilityFlags: ["nodejs_compat"],
    assets: {
      htmlHandling: "none",
      notFoundHandling: "none",
      runWorkerFirst: ["/*", "!/_next/static/*", "!/*/_next/static/*"],
    },
    env: {
      PAYPAL_SANDBOX: bindings.text("true"),
      PAYPAL_API_BASE_URL: bindings.text("https://api-m.sandbox.paypal.com"),
      GEMINI_MODEL: bindings.text("gemini-3.8-flash"),
      APP_URL: bindings.text("https://invoice-ready.graceperez769.workers.dev"),
      DATABASE_URL: bindings.secret(),
      APP_SECRET: bindings.secret(),
      ADMIN_TOKEN: bindings.secret(),
      PAYPAL_CLIENT_ID: bindings.secret(),
      PAYPAL_CLIENT_SECRET: bindings.secret(),
      GEMINI_API_KEY: bindings.secret(),
      ASSETS: bindings.assets(),
      AI: bindings.ai(),
    },
  }),
});
