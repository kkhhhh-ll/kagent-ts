import { describe, it, expect, vi } from "vitest";
import { ConsoleLogger, SilentLogger } from "../../src/logging/logger";

describe("ConsoleLogger", () => {
  it("formats with [Tag] prefix", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = new ConsoleLogger();

    logger.info("Test", "hello");

    expect(spy).toHaveBeenCalledWith("[Test] hello");
    spy.mockRestore();
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

    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    debugSpy.mockRestore();
  });
});

describe("SilentLogger", () => {
  it("does not throw on any log level", () => {
    const logger = new SilentLogger();

    expect(() => logger.info("A", "x")).not.toThrow();
    expect(() => logger.warn("A", "x")).not.toThrow();
    expect(() => logger.error("A", "x")).not.toThrow();
    expect(() => logger.debug("A", "x")).not.toThrow();
  });
});
