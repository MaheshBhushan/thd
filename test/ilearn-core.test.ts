import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeHtml, downloadFiles, isCurrent, parseCallArgs, planFiles, resolveCourse, safeName, type Assignment, type Course, type FileJob, type Section } from "../src/ilearn/core.ts";
import type { Moodle } from "../src/ilearn/moodle.ts";

const course = (id: number, fullname: string): Course => ({ id, shortname: fullname, fullname });
const file = (filename: string, filepath = "/", filesize = 10, timemodified = 1_700_000_000) =>
  ({ type: "file", filename, filepath, filesize, fileurl: `https://x/webservice/pluginfile.php/1${filepath}${filename}`, timemodified });

describe("resolveCourse", () => {
  const cs = [course(21926, "Advanced Statistical Methods"), course(21928, "Application Systems - ERP &amp; MES"), course(30000, "Statistics Lab")];

  test("a numeric argument is an id, never a name search", () => {
    expect(resolveCourse(cs, "21928").id).toBe(21928);
    expect(() => resolveCourse(cs, "1")).toThrow(/not enrolled/);
  });

  test("a unique substring matches case-insensitively, against decoded HTML", () => {
    expect(resolveCourse(cs, "advanced").id).toBe(21926);
    expect(resolveCourse(cs, "erp & mes").id).toBe(21928);
  });

  test("an ambiguous substring lists the candidates instead of guessing", () => {
    expect(() => resolveCourse(cs, "stat")).toThrow(/matches 2 courses[\s\S]*21926[\s\S]*30000/);
  });
});

describe("planFiles", () => {
  const sections: Section[] = [
    { id: 1, section: 0, name: "General", modules: [
      { id: 10, name: "Syllabus", modname: "resource", instance: 1, contents: [file("syllabus.pdf")] },
      { id: 11, name: "Announcements", modname: "forum", instance: 2 },
      { id: 12, name: "Page", modname: "page", instance: 3, contents: [file("index.html")] },
    ] },
    { id: 2, section: 1, name: "Week 1: Intro/Basics", modules: [
      { id: 20, name: "Slides", modname: "folder", instance: 4, contents: [file("a.pdf"), file("b.pdf", "/extra/")] },
      { id: 21, name: "Hidden", modname: "resource", instance: 5, uservisible: false, contents: [file("secret.pdf")] },
      { id: 22, name: "Link", modname: "url", instance: 6, contents: [{ ...file("x"), type: "url" }] },
    ] },
  ];
  const assigns: Assignment[] = [{ id: 9, cmid: 90, name: "Task 1", duedate: 0, cutoffdate: 0, allowsubmissionsfromdate: 0, introattachments: [file("sheet.pdf")] }];

  test("lays out resources, folders and assignment handouts by section", () => {
    expect(planFiles(sections, assigns).map((j) => j.path)).toEqual([
      "00 General/syllabus.pdf",
      "01 Week 1_ Intro_Basics/Slides/a.pdf",
      "01 Week 1_ Intro_Basics/Slides/extra/b.pdf",
      "Assignments/Task 1/sheet.pdf",
    ]);
  });

  test("skips hidden modules and only adds page HTML with --all-types", () => {
    const paths = planFiles(sections, [], { all: true }).map((j) => j.path);
    expect(paths).toContain("00 General/Page/index.html");
    expect(paths.some((p) => p.includes("secret"))).toBe(false);
  });

  test("two resources with the same filename in a section do not overwrite each other", () => {
    const dup: Section[] = [{ id: 1, section: 0, name: "S", modules: [
      { id: 1, name: "A", modname: "resource", instance: 1, contents: [file("notes.pdf")] },
      { id: 2, name: "B", modname: "resource", instance: 2, contents: [file("notes.pdf")] },
    ] }];
    expect(planFiles(dup, []).map((j) => j.path)).toEqual(["00 S/notes.pdf", "00 S/notes (2).pdf"]);
  });
});

describe("safeName / decodeHtml", () => {
  test("strips separators, leading dots (no escaping the target dir) and trailing dots (invalid on Windows)", () => {
    expect(safeName("../../etc/passwd")).toBe("__.._etc_passwd");
    expect(safeName("a:b*c?")).toBe("a_b_c_");
    expect(safeName("Report format.")).toBe("Report format");
  });

  test("decodes named and numeric entities", () => {
    expect(decodeHtml("ERP &amp; MES &#8211; &#x41;")).toBe("ERP & MES – A");
  });
});

describe("isCurrent", () => {
  const job: FileJob = { path: "a", url: "u", size: 100, mtime: 1000 };
  test("same size and not older than the server copy is current", () => {
    expect(isCurrent({ size: 100, mtimeMs: 1_000_000 }, job)).toBe(true);
  });
  test("a size change or an older local copy is re-downloaded", () => {
    expect(isCurrent({ size: 99, mtimeMs: 2_000_000 }, job)).toBe(false);
    expect(isCurrent({ size: 100, mtimeMs: 999_000 }, job)).toBe(false);
    expect(isCurrent(undefined, job)).toBe(false);
  });
});

describe("downloadFiles", () => {
  const dir = mkdtempSync(join(tmpdir(), "ilearn-test-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("writes files with server mtimes, skips them on re-run, and isolates failures", async () => {
    let calls = 0;
    const m = { download: async (url: string) => {
      calls++;
      if (url.includes("bad")) throw new Error("HTTP 404");
      return new Response("hello");
    } } as unknown as Moodle;
    const jobs: FileJob[] = [
      { path: "s/a.txt", url: "good", size: 5, mtime: 1_700_000_000 },
      { path: "s/b.txt", url: "bad", size: 5, mtime: 1_700_000_000 },
    ];
    const first = await downloadFiles(m, jobs, dir);
    expect(first.map((e) => e.kind)).toEqual(["done", "fail"]);
    expect(readFileSync(join(dir, "s/a.txt"), "utf8")).toBe("hello");
    expect(Math.floor(statSync(join(dir, "s/a.txt")).mtimeMs / 1000)).toBe(1_700_000_000);

    calls = 0;
    const second = await downloadFiles(m, jobs, dir);
    expect(second.map((e) => e.kind)).toEqual(["skip", "fail"]);
    expect(calls).toBe(1);
  });
});

describe("parseCallArgs", () => {
  test("bracket keys nest; JSON values parse; plain values stay strings", () => {
    expect(parseCallArgs(["courseids[0]=5", "options[0][name]=x", "ids=[1,2]", "q=hello=world"])).toEqual({
      courseids: { 0: "5" }, options: { 0: { name: "x" } }, ids: [1, 2], q: "hello=world",
    });
  });
  test("rejects an argument without '='", () => {
    expect(() => parseCallArgs(["oops"])).toThrow(/key=value/);
  });
});
