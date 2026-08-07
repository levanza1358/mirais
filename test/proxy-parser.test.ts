import { describe, expect, test } from "bun:test";
import { parseProxyLine, parseProxyText } from "../src/admin/proxyScraper";

describe("proxy parser", () => {
  test("parses a basic IPv4 entry", () => {
    expect(parseProxyLine("1.2.3.4:8080")).toEqual({ host: "1.2.3.4", port: 8080 });
  });
  test("ignores comments and blanks", () => {
    expect(parseProxyLine("# comment")).toBeNull();
    expect(parseProxyLine("")).toBeNull();
    expect(parseProxyLine("   ")).toBeNull();
  });
  test("captures 2-letter country code when present", () => {
    expect(parseProxyLine("5.6.7.8:9000:US")).toEqual({ host: "5.6.7.8", port: 9000, country: "US" });
  });
  test("rejects invalid ports", () => {
    expect(parseProxyLine("1.2.3.4:0")).toBeNull();
    expect(parseProxyLine("1.2.3.4:70000")).toBeNull();
    expect(parseProxyLine("1.2.3.4:notaport")).toBeNull();
  });
  test("rejects malformed hosts", () => {
    expect(parseProxyLine("not a host:8080")).toBeNull();
    expect(parseProxyLine("999.999.999.999:8080")).toBeNull();
  });
  test("deduplicates when parsing text", () => {
    const text = ["1.1.1.1:80", "1.1.1.1:80", "2.2.2.2:8080"].join("\n");
    expect(parseProxyText(text)).toEqual([
      { host: "1.1.1.1", port: 80 },
      { host: "2.2.2.2", port: 8080 },
    ]);
  });
  test("strips BOM and trailing annotations", () => {
    const text = "\uFEFF1.2.3.4:1080 some note";
    expect(parseProxyText(text)).toEqual([{ host: "1.2.3.4", port: 1080 }]);
  });
  test("captures username and password when present", () => {
    expect(parseProxyLine("31.59.20.176:6754:rslbrigs:p1xor2bbd19d")).toEqual({
      host: "31.59.20.176",
      port: 6754,
      username: "rslbrigs",
      password: "p1xor2bbd19d",
    });
  });
  test("drops credentials when only one half is provided", () => {
    expect(parseProxyLine("1.2.3.4:8080:useronly")).toEqual({ host: "1.2.3.4", port: 8080 });
    expect(parseProxyLine("1.2.3.4:8080::passonly")).toEqual({ host: "1.2.3.4", port: 8080 });
  });
  test("ignores malformed credentials", () => {
    expect(parseProxyLine("1.2.3.4:8080:bad user:badpass")).toEqual({ host: "1.2.3.4", port: 8080 });
  });
  test("bulk sample parses a realistic list", () => {
    const sample = [
      "31.59.20.176:6754:rslbrigs:p1xor2bbd19d",
      "31.56.127.193:7684:rslbrigs:p1xor2bbd19d",
      "45.38.107.97:6014:rslbrigs:p1xor2bbd19d",
      "198.105.121.200:6462:rslbrigs:p1xor2bbd19d",
    ];
    const out = parseProxyText(sample.join("\n"));
    expect(out.length).toBe(4);
    for (const entry of out) {
      expect(entry.username).toBe("rslbrigs");
      expect(entry.password).toBe("p1xor2bbd19d");
    }
  });
});