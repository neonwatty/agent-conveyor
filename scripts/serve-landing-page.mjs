import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const port = Number.parseInt(process.env.PORT ?? "8765", 10);
const host = process.env.HOST ?? "127.0.0.1";
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const landingPage = resolve(packageRoot, "docs/landing-page.html");

try {
  statSync(landingPage);
} catch {
  console.error(`Landing page not found: ${landingPage}`);
  process.exit(1);
}

const server = createServer((request, response) => {
  const path = new URL(request.url ?? "/", `http://${host}:${port}`).pathname;

  if (path !== "/" && path !== "/landing-page.html") {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found\n");
    return;
  }

  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  createReadStream(landingPage).pipe(response);
});

server.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});

server.listen(port, host, () => {
  console.log(`Agent Conveyor landing page: http://${host}:${port}/`);
  console.log("Press Ctrl+C to stop.");
});
