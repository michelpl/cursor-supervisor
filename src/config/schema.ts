import { z } from "zod";
import { defaultDataDir } from "./paths.js";

export const ConfigSchema = z.object({
  telegram: z.object({
    botToken: z.string().min(1),
    allowedUserIds: z.array(z.number().int()).min(1),
    parseMode: z.enum(["HTML", "Markdown", "plain"]).default("HTML"),
  }),
  cursor: z.object({
    apiKey: z.string().min(1),
    agentCliPath: z.string().default("agent"),
    acpMode: z.enum(["agent", "plan", "ask"]).default("agent"),
    interactionTimeoutMs: z.number().int().min(30_000).max(3_600_000).default(300_000),
  }),
  workspaces: z
    .object({
      autoRegisterCwd: z.boolean().default(true),
      allowedRoots: z.array(z.string()).default([]),
    })
    .default({ autoRegisterCwd: true, allowedRoots: [] }),
  mcpServers: z.record(z.string(), z.unknown()).optional(),
  paths: z
    .object({
      dataDir: z.string().default(() => defaultDataDir()),
    })
    .default(() => ({ dataDir: defaultDataDir() })),
  logging: z
    .object({ level: z.enum(["debug", "info", "warn", "error"]).default("info") })
    .default({ level: "info" }),
  reminders: z
    .object({
      timezone: z.string().default("America/Sao_Paulo"),
      maxAheadDays: z.number().int().min(1).max(365).default(30),
    })
    .default({ timezone: "America/Sao_Paulo", maxAheadDays: 30 }),
  attachments: z
    .object({
      maxFileSizeBytes: z
        .number()
        .int()
        .min(1024)
        .max(50 * 1024 * 1024)
        .default(20 * 1024 * 1024),
      maxAttachmentsPerFlush: z.number().int().min(1).max(50).default(10),
      maxRetries: z.number().int().min(0).max(5).default(3),
    })
    .default({
      maxFileSizeBytes: 20 * 1024 * 1024,
      maxAttachmentsPerFlush: 10,
      maxRetries: 3,
    }),
  images: z
    .object({
      maxImagesPerPrompt: z.number().int().min(1).max(16).default(8),
      defaultPromptSingle: z
        .string()
        .default("Analyze this image and describe what you see."),
      defaultPromptMulti: z
        .string()
        .default("Analyze these images and describe what you see."),
      mediaGroupDebounceMs: z.number().int().min(50).max(2000).default(800),
    })
    .default({
      maxImagesPerPrompt: 8,
      defaultPromptSingle: "Analyze this image and describe what you see.",
      defaultPromptMulti: "Analyze these images and describe what you see.",
      mediaGroupDebounceMs: 800,
    }),
  rateLimit: z
    .object({
      message: z
        .object({
          capacity: z.number().int().min(1).default(4),
          refillPerSec: z.number().min(0.1).default(2),
        })
        .default({ capacity: 4, refillPerSec: 2 }),
      sessionCreate: z
        .object({
          capacity: z.number().int().min(1).default(10),
          refillPerSec: z.number().min(0.01).default(10 / 60),
        })
        .default({ capacity: 10, refillPerSec: 10 / 60 }),
      reminders: z
        .object({ maxPerUser: z.number().int().min(1).default(100) })
        .default({ maxPerUser: 100 }),
    })
    .default({
      message: { capacity: 4, refillPerSec: 2 },
      sessionCreate: { capacity: 10, refillPerSec: 10 / 60 },
      reminders: { maxPerUser: 100 },
    }),
  power: z
    .object({
      preventSleep: z.boolean().default(true),
    })
    .default({ preventSleep: true }),
  voice: z
    .object({
      enabled: z.boolean().default(false),
      language: z.string().default("pt"),
      whisperCliPath: z.string().default("whisper-cli"),
      modelPath: z.string().default(""),
      ffmpegPath: z.string().default("ffmpeg"),
      timeoutMs: z.number().int().min(5_000).max(600_000).default(120_000),
    })
    .default({
      enabled: false,
      language: "pt",
      whisperCliPath: "whisper-cli",
      modelPath: "",
      ffmpegPath: "ffmpeg",
      timeoutMs: 120_000,
    }),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "ConfigError";
  }
}
