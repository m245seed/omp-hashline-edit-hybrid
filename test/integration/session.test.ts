import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { withStateDir } from "../support/env";

import {
  loadStore,
  requireStore,
  resetStoreForTests,
} from "../../src/state/database";
import { resetServed, serveLine, servedText } from "../../src/served/ledger";
import {
  getContextEpoch,
  resetContextEpoch,
} from "../../src/served/epoch";
import { registerSession } from "../../src/integration/session";
import { makeFakePi } from "../support/tools";

function makeCtx(): { ui: { notify: (msg: string) => void }; cwd: string } {
  return { ui: { notify: () => {} }, cwd: "/tmp" };
}

;

beforeEach(() => {
  withStateDir();
  resetServed();
  resetContextEpoch();
});

afterEach(async () => {
  await resetStoreForTests();
  resetContextEpoch();
});

describe("session lifecycle (spec §8.1, PH-CONTEXT-003)", () => {
  it("session_start resets served authorization", async () => {
    await loadStore();
    serveLine("/gone/f.ts", "Ab12", "stale authorization");

    const pi = makeFakePi();
    registerSession(pi as never, { value: true });
    await (pi.handlers.get("session_start") as (e: never, c: never) => Promise<void>)(
      {} as never,
      makeCtx() as never,
    );

    // Served authorization is session-scoped: the ledger was reset.
    expect(servedText("/gone/f.ts", "Ab12")).toBeUndefined();
  });

  it("session_compact advances the context epoch", () => {
    const pi = makeFakePi();
    registerSession(pi as never, { value: true });
    const before = getContextEpoch();
    (pi.handlers.get("session_compact") as () => void)();
    expect(getContextEpoch()).toBe(before + 1);
  });

  it("session_shutdown closes the persistent store", async () => {
    await loadStore();
    expect(() => requireStore()).not.toThrow();
    const pi = makeFakePi();
    registerSession(pi as never, { value: true });
    (pi.handlers.get("session_shutdown") as () => void)();
    expect(() => requireStore()).toThrow(/E_STATE_CORRUPT/);
  });

  it("toggle-auto-read flips the shared auto-read state", async () => {
    const autoReadState = { value: true };
    const pi = makeFakePi();
    registerSession(pi as never, autoReadState);
    const command = pi.commands.get("toggle-auto-read") as {
      handler: (args: never[], ctx: never) => Promise<void>;
    };
    let notified = "";
    await command.handler([], { ui: { notify: (msg: string) => (notified = msg) } } as never);
    expect(autoReadState.value).toBe(false);
    expect(notified).toContain("disabled");
    await command.handler([], { ui: { notify: () => {} } } as never);
    expect(autoReadState.value).toBe(true);
  });
});
