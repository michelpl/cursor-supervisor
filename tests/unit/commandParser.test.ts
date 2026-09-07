import { describe, it, expect } from "vitest";
import { parseCommand } from "../../src/commands/parser.js";

// text ParseResult text if
function asCmd(r: ReturnType<typeof parseCommand>) {
  if (r.type !== "command") {
    throw new Error(`expected command but got text: ${JSON.stringify(r)}`);
  }
  return r;
}

describe("CommandParser", () => {
  it("text", () => {
    const r = parseCommand("hello world");
    expect(r.type).toBe("text");
    if (r.type === "text") expect(r.text).toBe("hello world");
  });

  it("text text", () => {
    const r = parseCommand("");
    expect(r.type).toBe("text");
    if (r.type === "text") expect(r.text).toBe("");
  });

  it("text / text", () => {
    const r = parseCommand("/");
    expect(r.type).toBe("text");
  });

  it("/help text command name=help args=[]", () => {
    const r = asCmd(parseCommand("/help"));
    expect(r.name).toBe("help");
    expect(r.args).toEqual([]);
  });

  it("/ws add proj /tmp/p text text args", () => {
    const r = asCmd(parseCommand("/ws add proj /tmp/p"));
    expect(r.name).toBe("ws");
    expect(r.args).toEqual(["add", "proj", "/tmp/p"]);
    expect(r.rest).toBe("add proj /tmp/p");
  });

  it("/wslist and /wsadd parse as top-level commands", () => {
    expect(asCmd(parseCommand("/wslist")).name).toBe("wslist");
    const add = asCmd(parseCommand("/wsadd proj /tmp/p"));
    expect(add.name).toBe("wsadd");
    expect(add.args).toEqual(["proj", "/tmp/p"]);
  });

  it("text", () => {
    expect(asCmd(parseCommand("/Help")).name).toBe("help");
  });

  it("Telegram bot text /cmd@MyBot text text @MyBot", () => {
    const r = asCmd(parseCommand("/ws@MyBot list"));
    expect(r.name).toBe("ws");
    expect(r.args).toEqual(["list"]);
  });

  it("text", () => {
    expect(asCmd(parseCommand("/ws   add    proj")).args).toEqual([
      "add",
      "proj",
    ]);
  });

  it("text", () => {
    const r = asCmd(parseCommand("   /help   "));
    expect(r.name).toBe("help");
  });

  it("rest text payloadtext /remind text", () => {
    const r = asCmd(parseCommand("/remind 5m drink water now"));
    expect(r.name).toBe("remind");
    expect(r.rest).toBe("5m drink water now");
  });

  it("text", () => {
    expect(asCmd(parseCommand("/123")).name).toBe("123");
  });

  it("force text ! text CommandParser text busyPolicytext", () => {
    const r = parseCommand("!hello");
    expect(r.type).toBe("text");
    if (r.type === "text") expect(r.text).toBe("!hello");
  });
});
