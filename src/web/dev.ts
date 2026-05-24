import { memoryService } from "../memory/runtime.ts";
import { startMemoryExplorer } from "./server.ts";

const port = parseInt(process.env["PORT"] ?? "3000", 10);

startMemoryExplorer(memoryService, port, { dev: true, openBrowser: true });
console.log("Editing src/web/index.html will hot-reload the browser. Ctrl+C to stop.");
