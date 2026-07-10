import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionRegistry } from "../../src/session/SessionRegistry.js";
import type { Engine, OpenOptions, Session } from "../../src/engine/Engine.js";

/**
 * A minimal fake engine — SessionRegistry only calls open()/close() on it.
 * Cast through unknown so we don't have to stub the full Engine surface.
 */
function fakeEngine() {
  let n = 0;
  const closed: string[] = [];
  const engine = {
    id: "fake",
    open: async (opts: OpenOptions): Promise<Session> => ({
      id: `s${++n}`,
      platform: opts.platform,
    }),
    close: async (session: Session): Promise<void> => {
      closed.push(session.id);
    },
  };
  return { engine: engine as unknown as Engine, closed };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SessionRegistry lifecycle", () => {
  it("opens, routes engineFor, and closes a session", async () => {
    const { engine, closed } = fakeEngine();
    const reg = new SessionRegistry({ idleTimeoutMs: 0 });
    reg.register("web", engine);

    const session = await reg.open({ platform: "web", url: "https://x" });
    expect(reg.engineFor(session.id)).toBe(engine);
    expect(reg.platformOf(session.id)).toBe("web");

    await reg.close(session);
    expect(closed).toContain(session.id);
    // reuse after close throws unknown_session
    expect(() => reg.engineFor(session.id)).toThrowError();
  });

  it("rejects an unregistered platform", async () => {
    const reg = new SessionRegistry({ idleTimeoutMs: 0 });
    await expect(reg.open({ platform: "ios" })).rejects.toMatchObject({
      code: "unsupported_platform",
    });
  });

  it("shutdown closes every open session", async () => {
    const { engine, closed } = fakeEngine();
    const reg = new SessionRegistry({ idleTimeoutMs: 0 });
    reg.register("web", engine);
    const a = await reg.open({ platform: "web", url: "https://a" });
    const b = await reg.open({ platform: "web", url: "https://b" });
    await reg.shutdown();
    expect(closed).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(() => reg.engineFor(a.id)).toThrowError();
  });

  it("idle sweep closes a session past its timeout", async () => {
    vi.useFakeTimers();
    const { engine, closed } = fakeEngine();
    const reg = new SessionRegistry({ idleTimeoutMs: 40_000 });
    reg.register("web", engine);
    const s = await reg.open({ platform: "web", url: "https://x" });
    // sweep interval = max(30_000, 40_000/4) = 30_000; advance past both the
    // idle cutoff and one interval tick.
    await vi.advanceTimersByTimeAsync(80_000);
    expect(closed).toContain(s.id);
  });
});
