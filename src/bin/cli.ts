import { Command } from "commander";

import { readFileSync } from "node:fs";

import { loadConfig } from "../config/loadConfig.js";

import { resolveConfigFilePath, defaultConfigPath } from "../config/paths.js";

import { logger } from "../logger.js";

import { ServiceLock } from "../core/service/ServiceLock.js";

import { isProcessAlive } from "../core/service/processAlive.js";

import { postControlPrompt } from "../core/service/controlClient.js";

import { WorkspaceAddError } from "../core/workspace/addWorkspace.js";

import { runBot } from "./runBot.js";

import { wsAddCommand } from "./wsAddCommand.js";



export interface ServiceStatusOutput {

  running: boolean;

  stale?: boolean;

  pid?: number;

  startedAt?: string;

  configPath?: string;

  cwd?: string;

  startedBy?: string;

  controlReady?: boolean;

}



export async function getServiceStatus(configPath: string): Promise<ServiceStatusOutput> {

  const cfg = await loadConfig({ configPath });

  const lock = new ServiceLock(cfg.paths.dataDir);

  const status = await lock.readStatus();

  if (!status.record) {

    return { running: false };

  }

  return {

    running: status.running,

    stale: status.stale,

    pid: status.record.pid,

    startedAt: status.record.startedAt,

    configPath: status.record.configPath,

    cwd: status.record.cwd,

    startedBy: status.record.startedBy,

    controlReady: !!(status.record.controlPort && status.record.controlToken),

  };

}



export async function stopService(

  configPath: string,

  timeoutMs = 15_000,

): Promise<{ stopped: boolean; message: string }> {

  const cfg = await loadConfig({ configPath });

  const lock = new ServiceLock(cfg.paths.dataDir);

  const status = await lock.readStatus();



  if (!status.record) {

    return { stopped: true, message: "Cursor Supervisor is not running (no lock file)" };

  }



  if (!status.running) {

    await lock.release();

    return {

      stopped: true,

      message: `removed stale lock (pid ${status.record.pid} was not alive)`,

    };

  }



  const pid = status.record.pid;

  try {

    process.kill(pid, "SIGTERM");

  } catch (e) {

    return {

      stopped: false,

      message: `failed to signal pid ${pid}: ${(e as Error).message}`,

    };

  }



  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {

    if (!isProcessAlive(pid)) {

      await lock.release();

      return { stopped: true, message: `stopped pid ${pid}` };

    }

    await new Promise((r) => setTimeout(r, 200));

  }



  return {

    stopped: false,

    message: `pid ${pid} did not exit within ${timeoutMs}ms`,

  };

}



async function readPromptText(args: string[]): Promise<string> {

  if (args.length === 1 && args[0] === "-") {

    return readFileSync(0, "utf8").trim();

  }

  if (args.length > 0) {

    return args.join(" ").trim();

  }

  if (!process.stdin.isTTY) {

    return readFileSync(0, "utf8").trim();

  }

  throw new Error("prompt text required (pass arguments, -, or pipe stdin)");

}



function buildProgram(): Command {

  const program = new Command()

    .name("cursor-supervisor")

    .description("Telegram ↔ Cursor ACP bridge")

    .version("0.2.0");



  const configOption = [

    "--config-path <path>",

    `Path to config.json (default: ${defaultConfigPath()}, or CURSOR_SUPERVISOR_CONFIG)`,

  ] as const;



  program

    .command("run", { isDefault: true })

    .description("Start the Cursor Supervisor service")

    .option(...configOption)

    .option("--started-by <source>", "Lock metadata: cli or extension", "cli")

    .action(async (opts: { configPath?: string; startedBy: string }) => {

      const startedBy = opts.startedBy === "extension" ? "extension" : "cli";

      const configPath = await resolveConfigFilePath(opts.configPath);

      await runBot({ configPath, startedBy });

    });



  program

    .command("status")

    .description("Show service status")

    .option(...configOption)

    .option("--json", "Output JSON")

    .action(async (opts: { configPath?: string; json?: boolean }) => {

      const abs = await resolveConfigFilePath(opts.configPath);

      const out = await getServiceStatus(abs);

      if (opts.json) {

        process.stdout.write(`${JSON.stringify(out)}\n`);

      } else if (out.running) {

        const control = out.controlReady ? ", control ready" : "";

        process.stdout.write(

          `running (pid ${out.pid}, since ${out.startedAt}, config ${out.configPath}${control})\n`,

        );

      } else if (out.stale) {

        process.stdout.write(`stale lock (pid ${out.pid} not alive)\n`);

      } else {

        process.stdout.write("not running\n");

      }

    });



  program

    .command("stop")

    .description("Stop the running service")

    .option(...configOption)

    .option("--timeout-ms <ms>", "Grace period before reporting failure", "15000")

    .action(async (opts: { configPath?: string; timeoutMs: string }) => {

      const abs = await resolveConfigFilePath(opts.configPath);

      const result = await stopService(abs, Number(opts.timeoutMs));

      if (result.stopped) {

        process.stdout.write(`${result.message}\n`);

      } else {

        process.stderr.write(`${result.message}\n`);

        process.exit(1);

      }

    });



  program

    .command("prompt")

    .description("Start an ACP run via the local control server (mirrors to Telegram)")

    .argument("[text...]", "Prompt text (or - / stdin)")

    .option(...configOption)

    .option("--force", "Cancel a busy run and start this prompt")

    .option("--workspace <id>", "Workspace id/name to use")

    .action(

      async (

        textParts: string[],

        opts: { configPath?: string; force?: boolean; workspace?: string },

      ) => {

        const abs = await resolveConfigFilePath(opts.configPath);

        const cfg = await loadConfig({ configPath: abs });

        const lock = new ServiceLock(cfg.paths.dataDir);

        const status = await lock.readStatus();

        if (!status.running || !status.record) {

          process.stderr.write(

            "Cursor Supervisor is not running. Start it with `cursor-supervisor run` or the extension.\n",

          );

          process.exit(1);

        }

        const { controlPort, controlToken } = status.record;

        if (!controlPort || !controlToken) {

          process.stderr.write(

            "Service is running but has no control endpoint. Restart Cursor Supervisor to enable prompts.\n",

          );

          process.exit(1);

        }



        let text: string;

        try {

          text = await readPromptText(textParts);

        } catch (e) {

          process.stderr.write(`${(e as Error).message}\n`);

          process.exit(1);

          return;

        }

        if (!text) {

          process.stderr.write("empty prompt\n");

          process.exit(1);

        }



        const result = await postControlPrompt(controlPort, controlToken, {

          text,

          force: opts.force === true,

          workspaceId: opts.workspace,

          origin: "cli",

        });



        if (result.status === 202) {

          process.stdout.write("accepted — progress will appear on Telegram\n");

          return;

        }

        if (result.status === 409) {

          process.stderr.write(

            "agent is busy — use --force or prefix the prompt with !\n",

          );

          process.exit(1);

        }

        const errBody =

          result.body && typeof result.body === "object" && "error" in result.body

            ? String((result.body as { error: unknown }).error)

            : `HTTP ${result.status}`;

        process.stderr.write(`prompt failed: ${errBody}\n`);

        process.exit(1);

      },

    );



  const ws = program.command("ws").description("Workspace registry commands");



  ws.command("add")

    .description("Register and activate a workspace (live via control server, or offline)")

    .argument("<name>", "Workspace id/name")

    .argument("<path>", "Absolute path to an existing directory")

    .option(...configOption)

    .action(async (name: string, path: string, opts: { configPath?: string }) => {

      try {

        const result = await wsAddCommand({

          name,

          path,

          configPath: opts.configPath,

        });

        process.stdout.write(

          `Workspace added and active: ${result.name}\n${result.path}\n(via ${result.via})\n`,

        );

      } catch (e) {

        if (e instanceof WorkspaceAddError) {

          process.stderr.write(`${e.message}\n`);

          process.exit(1);

          return;

        }

        throw e;

      }

    });



  return program;

}



export async function runCli(argv: string[] = process.argv): Promise<void> {

  try {

    await buildProgram().parseAsync(argv);

  } catch (e) {

    logger.error({ err: (e as Error).message }, "fatal");

    process.exit(1);

  }

}


