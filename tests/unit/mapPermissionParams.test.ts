import { describe, it, expect } from "vitest";
import { mapPermissionParams } from "../../src/core/orchestrator/acpRuntime.js";
import type { PermissionRequestParams } from "../../src/adapters/acp/acpTypes.js";

describe("mapPermissionParams", () => {
  it("maps ACP toolCall.execute command and options", () => {
    const params: PermissionRequestParams = {
      toolCall: {
        toolCallId: "tc-1",
        title: "Run shell command",
        kind: "execute",
        rawInput: { command: "npm test" },
      },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    };
    const mapped = mapPermissionParams(params);
    expect(mapped.tool).toBe("execute");
    expect(mapped.detail).toBe("npm test");
    expect(mapped.summary).toContain("npm test");
    expect(mapped.options).toEqual([
      { optionId: "allow-once", name: "Allow once" },
      { optionId: "reject-once", name: "Reject" },
    ]);
  });

  it("falls back to default options when ACP omits them", () => {
    const mapped = mapPermissionParams({
      toolCall: { kind: "read", title: "Read file", rawInput: { path: "a.ts" } },
    });
    expect(mapped.options.map((o) => o.optionId)).toEqual([
      "allow-once",
      "allow-always",
      "reject-once",
    ]);
  });

  it("still supports legacy stub tool/summary fields", () => {
    const mapped = mapPermissionParams({
      tool: "shell",
      summary: "custom summary",
      args: { command: "ls" },
    });
    expect(mapped.tool).toBe("shell");
    expect(mapped.summary).toBe("custom summary");
    expect(mapped.detail).toBe("ls");
  });
});
