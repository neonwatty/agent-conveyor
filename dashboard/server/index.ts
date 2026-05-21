import http from "node:http";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import express from "express";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { createServer as createViteServer } from "vite";
import pty from "@homebridge/node-pty-prebuilt-multiarch";

import {
  buildPtyAttachArgs,
  normalizeServerOptions,
  runWorkerctlJson,
  runWorkerctlReceipt,
  type PartialServerOptions,
} from "./workerctl.ts";

function resolveExecutable(name: string): string {
  const result = spawnSync("/bin/sh", ["-lc", `command -v ${name}`], { encoding: "utf8" });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : name;
}

type TerminalProcess = {
  kill: () => void;
  onData: (callback: (data: string) => void) => void;
  onExit: (callback: () => void) => void;
  write: (data: string) => void;
};

function spawnScriptTmuxAttach(session: string): TerminalProcess {
  const child: ChildProcessWithoutNullStreams = spawn(
    resolveExecutable("script"),
    ["-q", "/dev/null", resolveExecutable("tmux"), "attach", "-t", session],
    { cwd: process.cwd(), env: process.env },
  );
  return {
    kill: () => child.kill(),
    onData: (callback) => {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", callback);
      child.stderr.on("data", callback);
    },
    onExit: (callback) => {
      child.on("close", callback);
      child.on("exit", callback);
    },
    write: (data) => child.stdin.write(data),
  };
}

function parseArgs(argv: string[]): PartialServerOptions {
  const options: PartialServerOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--host") {
      options.host = value;
      index += 1;
    } else if (arg === "--port") {
      options.port = Number(value);
      index += 1;
    } else if (arg === "--task") {
      options.task = value;
      index += 1;
    } else if (arg === "--workerctl-path") {
      options.workerctlPath = value;
      index += 1;
    } else if (arg === "--db-path") {
      options.dbPath = value;
      index += 1;
    }
  }
  return options;
}

async function main(): Promise<void> {
  const options = normalizeServerOptions(parseArgs(process.argv.slice(2)));
  const app = express();
  const server = http.createServer(app);
  const sockets = new WebSocketServer({ noServer: true });

  app.use(express.json());
  app.get("/api/config", (_request, response) => {
    response.json({ host: options.host, port: options.port, task: options.task ?? null });
  });
  app.get("/api/tasks", async (_request, response, next) => {
    try {
      response.json(await runWorkerctlJson({ command: "tasks", workerctlPath: options.workerctlPath, dbPath: options.dbPath }));
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/sessions", async (_request, response, next) => {
    try {
      response.json(await runWorkerctlJson({ command: "sessions", workerctlPath: options.workerctlPath, dbPath: options.dbPath }));
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/snapshot", async (request, response, next) => {
    try {
      const task = String(request.query.task || options.task || "");
      response.json(await runWorkerctlJson({ command: "snapshot", task, workerctlPath: options.workerctlPath, dbPath: options.dbPath }));
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/actions/cycle", async (request, response, next) => {
    try {
      const task = String(request.body.task || options.task || "");
      response.json(await runWorkerctlReceipt({ command: "cycle", task, workerctlPath: options.workerctlPath, dbPath: options.dbPath }));
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/actions/bind", async (request, response, next) => {
    try {
      response.json(await runWorkerctlReceipt({
        command: "bind",
        manager: String(request.body.manager || ""),
        task: String(request.body.task || options.task || ""),
        worker: String(request.body.worker || ""),
        workerctlPath: options.workerctlPath,
        dbPath: options.dbPath,
      }));
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/actions/nudge", async (request, response, next) => {
    try {
      response.json(await runWorkerctlReceipt({
        command: "nudge",
        dryRun: Boolean(request.body.dryRun),
        session: String(request.body.session || ""),
        text: String(request.body.text || ""),
        workerctlPath: options.workerctlPath,
        dbPath: options.dbPath,
      }));
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/actions/interrupt", async (request, response, next) => {
    try {
      response.json(await runWorkerctlReceipt({
        command: "interrupt",
        dryRun: Boolean(request.body.dryRun),
        followup: request.body.followup ? String(request.body.followup) : undefined,
        key: request.body.key ? String(request.body.key) : undefined,
        session: String(request.body.session || ""),
        workerctlPath: options.workerctlPath,
        dbPath: options.dbPath,
      }));
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/actions/finish", async (request, response, next) => {
    try {
      response.json(await runWorkerctlReceipt({
        command: "finish",
        requireCriteriaAudit: Boolean(request.body.requireCriteriaAudit),
        task: String(request.body.task || options.task || ""),
        workerctlPath: options.workerctlPath,
        dbPath: options.dbPath,
      }));
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/actions/export", async (request, response, next) => {
    try {
      response.json(await runWorkerctlReceipt({
        command: "export",
        task: String(request.body.task || options.task || ""),
        workerctlPath: options.workerctlPath,
        dbPath: options.dbPath,
        zip: Boolean(request.body.zip),
      }));
    } catch (error) {
      next(error);
    }
  });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "/", `http://${request.headers.host}`);
    if (url.pathname !== "/pty") {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws: WebSocket) => {
      sockets.emit("connection", ws, request, url);
    });
  });

  sockets.on("connection", (ws: WebSocket, _request: http.IncomingMessage, url: URL) => {
    const session = url.searchParams.get("session") || "";
    const [, ...args] = buildPtyAttachArgs({ session });
    let term: TerminalProcess;
    try {
      const ptyTerm = pty.spawn(resolveExecutable("tmux"), args, {
        cols: 120,
        rows: 36,
        name: "xterm-256color",
        cwd: process.cwd(),
        env: process.env,
      });
      term = {
        kill: () => ptyTerm.kill(),
        onData: (callback) => ptyTerm.onData(callback),
        onExit: (callback) => ptyTerm.onExit(callback),
        write: (data) => ptyTerm.write(data),
      };
    } catch (error) {
      try {
        term = spawnScriptTmuxAttach(session);
      } catch (fallbackError) {
        ws.send(`Failed to attach tmux session ${session}: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}\r\n`);
        ws.close();
        return;
      }
    }
    term.onData((data) => ws.send(data));
    term.onExit(() => ws.close());
    ws.on("message", (message: RawData) => term.write(message.toString()));
    ws.on("close", () => term.kill());
  });

  const vite = await createViteServer({
    root: "dashboard",
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);

  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  });

  server.listen(options.port, options.host, () => {
    console.log(`workerctl dashboard: http://${options.host}:${options.port}/`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
