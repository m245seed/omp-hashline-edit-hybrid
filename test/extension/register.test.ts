import { describe, expect, it } from "vitest";
import { withStateDir } from "../support/env";
import { makeFakePi } from "../support/tools";
import factory from "../../index";

describe("extension registration", () => {
  it("registers the six hybrid tools and lifecycle hooks", () => {
    withStateDir();
    const pi = makeFakePi();
    factory(pi as never);

    expect([...pi.tools.keys()].sort()).toEqual(["edit", "grep", "insert", "read", "undo", "write"]);
    // Every tool carries the pieces pi needs: name, description, parameters, execute.
    for (const [name, tool] of pi.tools) {
      expect(tool.name).toBe(name);
      expect(typeof tool.description).toBe("string");
      expect(tool.parameters).toBeDefined();
      expect(typeof tool.execute).toBe("function");
    }
    // Tool descriptions are short and carry the core protocol rules.
    expect(pi.tools.get("edit")!.description).toContain("anchors");
    expect(pi.tools.get("edit")!.description).toMatch(/nothing is modified/i);
    expect(pi.tools.get("edit")!.description).toContain("one transaction");
    expect(pi.tools.get("insert")!.description).toContain("anchor");
    expect(pi.tools.get("undo")!.description).toMatch(/without overwriting anything/);
    // PH-PROTO-002: every tool declares the protocol id and anchor width.
    for (const [, tool] of pi.tools) {
      expect(tool.description).toContain("Protocol-ID: pi-hashline/1");
      expect(tool.description).toContain("anchor width 4");
    }
    // PH-PROTO-001: every tool carries a stable protocol identifier. The
    // per-schema `$id` is preferred, but some upstreams (xAI/Grok, DeepSeek
    // routes via OpenAI-compatible gateways) reject `$id` in tool schemas, so
    // the description-level `Protocol-ID` (verified by PH-PROTO-002) is the
    // fallback identifier.
    for (const [, tool] of pi.tools) {
      const schemaId = (tool.parameters as { $id?: string }).$id;
      const descriptionId = /Protocol-ID:\s*([A-Za-z0-9_\-./@]+)/i.exec(tool.description ?? "")?.[1];
      expect(schemaId ?? descriptionId).toMatch(/^pi-hashline\/(?:[a-z]+@1|1)$/);
    }

    expect(pi.handlers.has("session_start")).toBe(true);
    expect(pi.handlers.has("session_shutdown")).toBe(true);
    expect(pi.handlers.has("tool_result")).toBe(true);
    expect(pi.commands.has("toggle-auto-read")).toBe(true);
  });
});
