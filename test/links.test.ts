import { expect, test } from "bun:test";
import { mailLinks } from "../src/links.ts";

const site = "https://ilearn.th-deg.de";

// Shapes of real iLearn notification mails (forum post, assignment due-date reminder), anonymised.
test("forum mail: course from X-Course-Id, discussion keeps the #p post anchor, profile/picture links ignored", () => {
  const links = mailLinks(
    {
      headers: { "Message-ID": "<9d4f…@ilearn.th-deg.de>", "X-Course-Id": "1001", "X-Course-Name": "COURSE-X: Example Course", From: '"Lecturer Name (über iLearn)" <no-reply@th-deg.de>' },
      text: [
        "COURSE-X » Forums » Announcements » Deadline extension",
        "https://ilearn.th-deg.de/mod/forum/discuss.php?d=2002",
        "https://ilearn.th-deg.de/user/view.php?id=4711&course=1001",
        "See this post in context: https://ilearn.th-deg.de/mod/forum/discuss.php?d=2002#p3003.",
        "https://ilearn.th-deg.de/mod/forum/index.php?id=1001",
      ].join("\n"),
      html: '<img src="https://ilearn.th-deg.de/pluginfile.php/99/user/icon/boost/f2"><a href="https://ilearn.th-deg.de/mod/forum/view.php?f=55">Announcements</a>',
    },
    site,
  );
  expect(links.fromIlearn).toBe(true);
  expect(links.courseId).toBe(1001);
  expect(links.refs.map((r) => [r.kind, r.id, r.kind === "discussion" ? r.post : undefined])).toEqual([
    ["discussion", 2002, 3003],
    ["course", 1001, undefined],
  ]);
});

test("assignment reminder: HTML-escaped query (&amp;) still yields the module cmid", () => {
  const links = mailLinks(
    { headers: { "Message-ID": "<6ae5…@ilearn.th-deg.de>" }, text: "", html: '<a href="https://ilearn.th-deg.de/mod/assign/view.php?id=4004&amp;action=view">Assignment 2</a>' },
    site,
  );
  expect(links.refs).toEqual([{ kind: "module", id: 4004, modname: "assign", url: "https://ilearn.th-deg.de/mod/assign/view.php?id=4004&action=view" }]);
  expect(links.courseId).toBeUndefined();
});

test("links to other hosts and plain mail from no-reply without iLearn links are not iLearn mail", () => {
  const links = mailLinks({ headers: { From: "no-reply@th-deg.de", "Message-ID": "<x@mail.th-deg.de>" }, text: "https://evil.example/mod/assign/view.php?id=1 https://www.th-deg.de/course/view.php?id=2" }, site);
  expect(links).toEqual({ fromIlearn: false, refs: [] });
});
