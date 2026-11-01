/**
 * Mail ↔ iLearn. iLearn notification mails come from no-reply@th-deg.de with a Message-ID at
 * ilearn.th-deg.de, carry `X-Course-Id`/`X-Course-Name` (forum mails) and link to the item:
 *   /mod/forum/discuss.php?d=<discussion>#p<post>, /mod/assign/view.php?id=<cmid>,
 *   /mod/<mod>/view.php?id=<cmid>, /course/view.php?id=<course>, /mod/forum/index.php?id=<course>.
 */
import type { MessageView } from "./mail/mail.ts";
import type { Moodle } from "./ilearn/moodle.ts";
import * as core from "./ilearn/core.ts";

export type IlearnRef =
  | { kind: "course"; id: number; url: string }
  | { kind: "discussion"; id: number; post?: number; url: string }
  | { kind: "module"; id: number; modname: string; url: string };

export interface MailLinks {
  fromIlearn: boolean;
  courseId?: number;
  courseName?: string;
  refs: IlearnRef[];
}

const URL_RE = /https?:\/\/[^\s"'<>()]+/g;

/** Pure: find iLearn references in a parsed message (headers, text and HTML). */
export function mailLinks(v: Pick<MessageView, "headers" | "text" | "html">, site: string): MailLinks {
  const host = new URL(site).hostname;
  const header = (name: string) => Object.entries(v.headers).find(([k]) => k.toLowerCase() === name)?.[1];
  const refs: IlearnRef[] = [];
  const seen = new Set<string>();
  const add = (r: IlearnRef) => {
    const key = `${r.kind}:${r.id}`;
    if (seen.has(key)) {
      // Keep the post anchor if a later link to the same discussion has one.
      const prev = refs.find((x) => `${x.kind}:${x.id}` === key);
      if (prev?.kind === "discussion" && r.kind === "discussion" && r.post && !prev.post) prev.post = r.post;
      return;
    }
    seen.add(key);
    refs.push(r);
  };
  for (const raw of `${v.text}\n${v.html ?? ""}`.match(URL_RE) ?? []) {
    let u: URL;
    try {
      u = new URL(raw.replace(/&amp;/g, "&").replace(/[.,;:]+$/, ""));
    } catch {
      continue;
    }
    if (u.hostname !== host) continue;
    const id = Number(u.searchParams.get("id"));
    const path = u.pathname;
    let m: RegExpExecArray | null;
    if (path === "/mod/forum/discuss.php" && Number(u.searchParams.get("d"))) {
      const post = Number(/^#p(\d+)$/.exec(u.hash)?.[1]) || undefined;
      add({ kind: "discussion", id: Number(u.searchParams.get("d")), ...(post ? { post } : {}), url: u.toString() });
    } else if ((path === "/course/view.php" || path === "/mod/forum/index.php" || path === "/course/user.php") && id) {
      add({ kind: "course", id, url: u.toString() });
    } else if ((m = /^\/mod\/(\w+)\/view\.php$/.exec(path)) && id) {
      add({ kind: "module", id, modname: m[1]!, url: u.toString() });
    }
  }
  const courseHeader = Number(header("x-course-id"));
  const courseId = courseHeader || refs.find((r) => r.kind === "course")?.id;
  const from = header("from") ?? "";
  const messageId = header("message-id") ?? "";
  const result: MailLinks = { fromIlearn: messageId.includes(`@${host}`) || (/no-reply@th-deg\.de/i.test(from) && refs.length > 0), refs };
  if (courseId) result.courseId = courseId;
  const courseName = header("x-course-name");
  if (courseName) result.courseName = courseName;
  return result;
}

export type Resolved =
  | { ref: IlearnRef; kind: "course"; name: string }
  | { ref: IlearnRef; kind: "assignment"; status: core.AssignmentStatus }
  | { ref: IlearnRef; kind: "discussion"; posts: core.Post[] }
  | { ref: IlearnRef; kind: "module"; name: string; modname: string }
  | { ref: IlearnRef; kind: "error"; error: string };

/** Look each reference up in iLearn. One failing reference does not hide the others. */
export async function resolveRefs(m: Moodle, userid: number, links: MailLinks): Promise<Resolved[]> {
  const out: Resolved[] = [];
  let courses: core.Course[] | undefined;
  // Course context first, then the items in the order the mail links them.
  const refs = [...links.refs.filter((r) => r.kind === "course"), ...links.refs.filter((r) => r.kind !== "course")];
  if (links.courseId && !refs.some((r) => r.kind === "course" && r.id === links.courseId)) refs.unshift({ kind: "course", id: links.courseId, url: "" });
  for (const ref of refs) {
    try {
      if (ref.kind === "course") {
        courses ??= await core.listCourses(m, userid, "all");
        const c = courses.find((x) => x.id === ref.id);
        out.push({ ref, kind: "course", name: c ? core.decodeHtml(c.fullname) : `course ${ref.id} (not enrolled)` });
      } else if (ref.kind === "discussion") {
        out.push({ ref, kind: "discussion", posts: await core.discussionPosts(m, ref.id, 50) });
      } else if (ref.modname === "assign") {
        out.push({ ref, kind: "assignment", status: await core.assignmentStatus(m, ref.id) });
      } else {
        const cm = await core.moduleInfo(m, ref.id);
        out.push({ ref, kind: "module", name: core.decodeHtml(cm.name), modname: cm.modname });
      }
    } catch (e) {
      out.push({ ref, kind: "error", error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

/** Subject search terms for a course's notification mails: Moodle prefixes subjects with the shortname. */
export function courseMailQuery(c: core.Course): string {
  return core.decodeHtml(c.shortname || c.fullname).trim();
}
