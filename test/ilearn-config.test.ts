import { describe, expect, test } from "bun:test";
import { DEFAULT_SITE, parseConfig, resolveToken } from "../src/ilearn/config.ts";

describe("parseConfig", () => {
  test("defaults the site to iLearn", () => {
    expect(parseConfig({}).site).toBe(DEFAULT_SITE);
  });

  test("rejects a site with a path, which would break every endpoint URL", () => {
    expect(() => parseConfig({ site: "https://ilearn.th-deg.de/my/" })).toThrow(/origin/);
  });
});

describe("resolveToken", () => {
  const cfg = parseConfig({ token: "from-file" });

  test("the environment wins over the config file", () => {
    expect(resolveToken(cfg, { ILEARN_TOKEN: "from-env" })).toBe("from-env");
  });

  test("falls back to the config file", () => {
    expect(resolveToken(cfg, {})).toBe("from-file");
  });

  test("no token anywhere points at `thd login ilearn`", () => {
    expect(() => resolveToken({ site: DEFAULT_SITE }, {})).toThrow(/thd login ilearn/);
  });
});
