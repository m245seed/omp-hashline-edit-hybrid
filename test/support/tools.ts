import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";

export interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  details?: Record<string, unknown>;
  isError?: boolean;
}

export async function runTool(
  tool: ToolDefinition<any, any>,
  params: unknown,
  cwd: string,
): Promise<ToolResult> {
  const result = (await tool.execute(
    "test-call-id",
    params,
    undefined,
    undefined,
    { cwd } as never,
  )) as unknown as ToolResult;
  return result;
}

export function textOf(result: ToolResult): string {
  return (result.content ?? [])
    .filter((entry): entry is { type: string; text: string } => typeof entry.text === "string")
    .map((entry) => entry.text)
    .join("\n");
}

export function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-hybrid-proj-"));
  return dir;
}

export function writeFileAt(dir: string, name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content, "utf-8");
  return path;
}

export function readFileAt(path: string): string {
  return require("fs").readFileSync(path, "utf-8");
}

export function anchorsFromRead(text: string): Map<string, string> {
  const anchors = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = line.match(/^([A-Za-z0-9]{4})│(.*)$/);
    if (match) anchors.set(match[2]!, match[1]!);
  }
  return anchors;
}

export function anchorsFromReadArray(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const match = line.match(/^([A-Za-z0-9]{4})│/);
    if (match) out.push(match[1]!);
  }
  return out;
}

export interface FakePi {
  on: (event: string, handler: (...args: never[]) => unknown) => void;
  registerCommand: (name: string, options: unknown) => void;
  registerTool: (tool: { name: string; description?: string; parameters?: unknown; execute?: (...args: unknown[]) => unknown }) => void;
  handlers: Map<string, (...args: never[]) => unknown>;
  commands: Map<string, unknown>;
  tools: Map<string, { name: string; description?: string; parameters?: unknown; execute?: (...args: unknown[]) => unknown }>;
}

export function makeFakePi(_autoRead?: { value: boolean }): FakePi {
  const handlers = new Map<string, (...args: never[]) => unknown>();
  const commands = new Map<string, unknown>();
  const tools = new Map<string, { name: string; description?: string; parameters?: unknown; execute?: (...args: unknown[]) => unknown }>();
  return {
    on(event: string, handler: (...args: never[]) => unknown) {
      handlers.set(event, handler);
    },
    registerCommand(name: string, options: unknown) {
      commands.set(name, options);
    },
    registerTool(tool: { name: string; description?: string; parameters?: unknown; execute?: (...args: unknown[]) => unknown }) {
      tools.set(tool.name, tool);
    },
    handlers,
    commands,
    tools,
  };
}
