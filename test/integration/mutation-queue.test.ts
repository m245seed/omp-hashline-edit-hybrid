import { describe, expect, it } from "vitest";
import { withFileMutationQueue } from "../../src/filesystem/resolve-target";

function deferred(): {
  promise: Promise<void>;
  release: () => void;
} {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("withFileMutationQueue (vendored host fallback)", () => {
  it("runs same-path mutations strictly in call order", async () => {
    const gate = deferred();
    const events: string[] = [];
    const first = withFileMutationQueue("a.txt", async () => {
      events.push("start-1");
      await gate.promise;
      events.push("end-1");
      return 1;
    });
    const second = withFileMutationQueue("a.txt", async () => {
      events.push("start-2");
      return 2;
    });
    const third = withFileMutationQueue("a.txt", async () => {
      events.push("start-3");
      return 3;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["start-1"]);
    gate.release();
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
    await expect(third).resolves.toBe(3);
    expect(events).toEqual(["start-1", "end-1", "start-2", "start-3"]);
  });

  it("delivers a rejection to its caller without breaking the chain", async () => {
    const sentinel = new Error("boom");
    const failing = withFileMutationQueue("b.txt", async () => {
      throw sentinel;
    });
    const after = withFileMutationQueue("b.txt", async () => "recovered");
    await expect(failing).rejects.toBe(sentinel);
    await expect(after).resolves.toBe("recovered");
  });

  it("does not serialize mutations for different paths", async () => {
    const gate = deferred();
    const blocked = withFileMutationQueue("c.txt", () => gate.promise);
    await expect(
      withFileMutationQueue("d.txt", async () => "free"),
    ).resolves.toBe("free");
    gate.release();
    await blocked;
  });
});
