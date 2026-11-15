import pino from "pino";
import { config } from "./config.js";

export const logger = pino({
  level: config.logLevel,
  base: { service: "places-discovery", env: config.env, version: config.version },
  redact: {
    paths: [
      "req.headers.cookie",
      "req.headers.authorization",
      "req.headers['x-csrf-token']",
      "*.api_key",
      "*.apiKey",
      "*.accessKey",
      "*.password",
      "*.token",
      "apiKey",
      "accessKey",
    ],
    censor: "[redacted]",
  },
});

export const workerLogger = logger.child({ component: "worker" });
