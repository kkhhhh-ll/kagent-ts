import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConsoleLogger, SilentLogger, LogLevel } from "../../src/logging/logger";

// ---------------------------------------------------------------------------
// ConsoleLogger — basic formatting
// ---------------------------------------------------------------------------

describe("ConsoleLogger", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("formats with [Tag] prefix", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = new ConsoleLogger();

    logger.info("Test", "hello");

    expect(spy).toHaveBeenCalledWith("[Test] hello");
  });

  it("maps levels to correct console methods", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const logger = new ConsoleLogger();

    logger.info("Tag", "info msg");
    logger.warn("Tag", "warn msg");
    logger.error("Tag", "err msg");
    logger.debug("Tag", "dbg msg");

    expect(logSpy).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// FIX 4: context serialization (was silently discarded)
// ---------------------------------------------------------------------------

describe("ConsoleLogger — context serialization", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("appends JSON context after the message", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = new ConsoleLogger();

    logger.info("HTTP", "Request completed", { statusCode: 200, durationMs: 42 });

    expect(spy).toHaveBeenCalledWith('[HTTP] Request completed {"statusCode":200,"durationMs":42}');
  });

  it("omits context when not provided (backward-compatible output)", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = new ConsoleLogger();

    logger.info("Tag", "no context");

    expect(spy).toHaveBeenCalledWith("[Tag] no context");
  });

  it("omits context when empty object is passed", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = new ConsoleLogger();

    logger.info("Tag", "empty context", {});

    expect(spy).toHaveBeenCalledWith("[Tag] empty context");
  });

  it("works for all four log levels", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = new ConsoleLogger();
    const ctx = { key: "v" };

    logger.debug("D", "d", ctx);
    logger.info("I", "i", ctx);
    logger.warn("W", "w", ctx);
    logger.error("E", "e", ctx);

    expect(debugSpy).toHaveBeenCalledWith('[D] d {"key":"v"}');
    expect(logSpy).toHaveBeenCalledWith('[I] i {"key":"v"}');
    expect(warnSpy).toHaveBeenCalledWith('[W] w {"key":"v"}');
    expect(errorSpy).toHaveBeenCalledWith('[E] e {"key":"v"}');
  });
});

// ---------------------------------------------------------------------------
// FIX 1: Error serialization (was {} due to non-enumerable props)
// ---------------------------------------------------------------------------

describe("ConsoleLogger — Error serialization", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("serializes Error objects with name, message, and stack", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = new ConsoleLogger();
    const err = new Error("timeout");

    logger.error("DB", "Connection failed", { error: err });

    const call = spy.mock.calls[0][0] as string;
    expect(call).toContain('"error"');
    expect(call).toContain('"name":"Error"');
    expect(call).toContain('"message":"timeout"');
    expect(call).toContain('"stack"');
  });

  it("handles nested Error objects in context values", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = new ConsoleLogger();
    const cause = new Error("connection reset");
    const outer = new Error("request failed");

    logger.error("HTTP", "Fail", { error: outer, cause });

    const call = spy.mock.calls[0][0] as string;
    expect(call).toContain('"message":"request failed"');
    expect(call).toContain('"message":"connection reset"');
  });

  it("handles BigInt values in context", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = new ConsoleLogger();

    logger.info("Perf", "Timing", { elapsedNs: BigInt(9007199254740991) });

    const call = spy.mock.calls[0][0] as string;
    expect(call).toContain("BigInt(9007199254740991)");
  });
});

// ---------------------------------------------------------------------------
// FIX 1+2: circular reference detection (was: all context lost via catch)
// ---------------------------------------------------------------------------

describe("ConsoleLogger — circular reference handling", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("replaces self-referencing objects with [Circular]", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = new ConsoleLogger();
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;

    logger.info("T", "circular", { obj });

    const call = spy.mock.calls[0][0] as string;
    expect(call).toContain("[Circular]");
    expect(call).toContain('"a":1'); // non-circular props still serialized
  });

  it("replaces self-referencing Errors with [Circular]", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = new ConsoleLogger();
    const err = new Error("loop");
    (err as Record<string, unknown>).cause = err;

    logger.error("T", "self-causal error", { error: err });

    const call = spy.mock.calls[0][0] as string;
    expect(call).toContain("[Circular]");
    expect(call).toContain('"message":"loop"'); // first occurrence serialized
  });

  it("handles mutually-referencing objects", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = new ConsoleLogger();
    const a: Record<string, unknown> = { label: "a" };
    const b: Record<string, unknown> = { label: "b" };
    a.b = b;
    b.a = a;

    logger.info("T", "mutual", { a, b });

    const call = spy.mock.calls[0][0] as string;
    // Each object should appear once with [Circular] on the back-reference
    expect(call).toContain("[Circular]");
    expect(call).toContain('"label":"a"');
    expect(call).toContain('"label":"b"');
  });
});

// ---------------------------------------------------------------------------
// FIX 3: child() with bound context
// ---------------------------------------------------------------------------

describe("ConsoleLogger — child() bound context", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("merges bound context into every log call", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const parent = new ConsoleLogger();
    const child = parent.child({ requestId: "req-1", userId: "u-1" });

    child.info("HTTP", "ok");

    expect(spy).toHaveBeenCalledWith('[HTTP] ok {"requestId":"req-1","userId":"u-1"}');
  });

  it("per-call context takes precedence over bound context", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const child = new ConsoleLogger().child({ requestId: "bound", userId: "bound" });

    child.info("HTTP", "ok", { requestId: "per-call" });

    expect(spy).toHaveBeenCalledWith('[HTTP] ok {"requestId":"per-call","userId":"bound"}');
  });

  it("child inherits minLevel from parent", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const parent = new ConsoleLogger({ minLevel: LogLevel.WARN });
    const child = parent.child({ requestId: "r" });

    child.info("T", "should be filtered");

    expect(spy).not.toHaveBeenCalled();
  });

  it("child of child accumulates bindings", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const root = new ConsoleLogger();
    const l1 = root.child({ a: 1 });
    const l2 = l1.child({ b: 2 });

    l2.info("T", "m", { c: 3 });

    expect(spy).toHaveBeenCalledWith('[T] m {"a":1,"b":2,"c":3}');
  });

  it("child with no context works like parent", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const child = new ConsoleLogger().child({});

    child.info("T", "m");

    expect(spy).toHaveBeenCalledWith("[T] m");
  });
});

// ---------------------------------------------------------------------------
// FIX 5: Log level filtering (with enabled flag replacing SILENT)
// ---------------------------------------------------------------------------

describe("ConsoleLogger — level filtering", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("default minLevel (DEBUG) outputs everything", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = new ConsoleLogger();

    logger.debug("T", "d");
    logger.info("T", "i");
    logger.warn("T", "w");
    logger.error("T", "e");

    expect(debugSpy).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("INFO filters out DEBUG", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = new ConsoleLogger({ minLevel: LogLevel.INFO });

    logger.debug("T", "d");
    logger.info("T", "i");

    expect(debugSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalled();
  });

  it("WARN filters out DEBUG and INFO", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logger = new ConsoleLogger({ minLevel: LogLevel.WARN });

    logger.debug("T", "d");
    logger.info("T", "i");
    logger.warn("T", "w");

    expect(debugSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("ERROR filters out everything below", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = new ConsoleLogger({ minLevel: LogLevel.ERROR });

    logger.warn("T", "w");
    logger.error("T", "e");

    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("enabled=false suppresses all output", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const logger = new ConsoleLogger({ enabled: false });

    logger.debug("T", "d");
    logger.error("T", "e");

    expect(debugSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("enabled=false overrides minLevel", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = new ConsoleLogger({ minLevel: LogLevel.DEBUG, enabled: false });

    logger.error("T", "e");

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("child inherits enabled=false from parent", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const parent = new ConsoleLogger({ enabled: false });
    const child = parent.child({ requestId: "r" });

    child.info("T", "m");

    expect(spy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// FIX 6: log injection sanitization
// ---------------------------------------------------------------------------

describe("ConsoleLogger — injection sanitization", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("escapes newlines in message", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = new ConsoleLogger();

    logger.info("HTTP", "ok\n[ERROR] FAKE!");

    expect(spy).toHaveBeenCalledWith("[HTTP] ok\\x0a[ERROR] FAKE!");
  });

  it("escapes carriage-return in message", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = new ConsoleLogger();

    logger.info("T", "hello\rworld");

    expect(spy).toHaveBeenCalledWith("[T] hello\\x0dworld");
  });

  it("escapes newlines in tag", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = new ConsoleLogger();

    logger.info("Evil\nTag", "msg");

    expect(spy).toHaveBeenCalledWith("[Evil\\x0aTag] msg");
  });

  it("escapes tab and null characters", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = new ConsoleLogger();

    logger.info("T", "a\tb\x00c");

    expect(spy).toHaveBeenCalledWith("[T] a\\x09b\\x00c");
  });

  it("leaves normal text unchanged", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = new ConsoleLogger();

    logger.info("MyAgent", "Task completed in 2.3s");

    expect(spy).toHaveBeenCalledWith("[MyAgent] Task completed in 2.3s");
  });

  it("sanitizes across all four log methods", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = new ConsoleLogger();

    logger.debug("T", "d\nx");
    logger.info("T", "i\nx");
    logger.warn("T", "w\nx");
    logger.error("T", "e\nx");

    expect(debugSpy).toHaveBeenCalledWith("[T] d\\x0ax");
    expect(logSpy).toHaveBeenCalledWith("[T] i\\x0ax");
    expect(warnSpy).toHaveBeenCalledWith("[T] w\\x0ax");
    expect(errorSpy).toHaveBeenCalledWith("[T] e\\x0ax");
  });
});

// ---------------------------------------------------------------------------
// FIX 7: _merge reference isolation
// ---------------------------------------------------------------------------

describe("ConsoleLogger — _merge reference isolation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("does not return the caller's original context object", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = new ConsoleLogger();
    const ctx: Record<string, unknown> = { key: "original" };

    logger.info("T", "m", ctx);

    // ctx should not have been mutated by the logger
    expect(ctx).toEqual({ key: "original" });
    expect(spy).toHaveBeenCalled();
  });

  it("isolates bindings from external mutation after child()", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const bindings: Record<string, unknown> = { reqId: "abc" };
    const child = new ConsoleLogger().child(bindings);

    // Mutate the original bindings object after creating child
    bindings.reqId = "hijacked";

    child.info("T", "m");

    // The child should still use the original value at creation time
    expect(spy).toHaveBeenCalledWith('[T] m {"reqId":"abc"}');
  });
});

// ---------------------------------------------------------------------------
// SilentLogger
// ---------------------------------------------------------------------------

describe("SilentLogger", () => {
  it("does not throw on any log level", () => {
    const logger = new SilentLogger();

    expect(() => logger.info("A", "x")).not.toThrow();
    expect(() => logger.warn("A", "x")).not.toThrow();
    expect(() => logger.error("A", "x")).not.toThrow();
    expect(() => logger.debug("A", "x")).not.toThrow();
  });

  it("child() returns a Logger that also does not throw", () => {
    const logger = new SilentLogger();
    const child = logger.child({ requestId: "r" });

    expect(() => child.info("A", "x")).not.toThrow();
    expect(() => child.error("A", "x", { err: new Error("e") })).not.toThrow();
  });

  it("child() with no args is safe", () => {
    const logger = new SilentLogger();
    expect(() => logger.child({}).info("A", "x")).not.toThrow();
  });
});
