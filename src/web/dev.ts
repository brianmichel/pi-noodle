import { createClient } from "@libsql/client";

import { resolveConfig } from "../config.ts";
import { startMemoryExplorer } from "./server.ts";

const config = resolveConfig();
const dbUrl =
  config.db.mode === "cloud"
    ? (config.db.url ?? "libsql://")
    : `file:${config.db.path}`;
const dbOptions: { url: string; authToken?: string } = { url: dbUrl };
if (config.db.mode === "cloud" && config.db.authToken) {
  dbOptions.authToken = config.db.authToken;
}

const port = parseInt(process.env["PORT"] ?? "3000", 10);
const db = createClient(dbOptions);

startMemoryExplorer(db, port, { dev: true, openBrowser: true });
console.log("Editing src/web/index.html will hot-reload the browser. Ctrl+C to stop.");
