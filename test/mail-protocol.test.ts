import { describe, expect, test } from "bun:test";
import { applyEdits, messageRows, ORPHAN_FORM, parseAjax, parseForms, serializeForm } from "../src/mail/protocol.ts";
import { parseVcards } from "../src/mail/contacts.ts";

// Fixtures are trimmed from real responses of webmail.stud.th-deg.de (Roundcube 1.6.20).

describe("AJAX responses", () => {
  test("an expired session is a 200 JSON reply calling session_error, not an HTTP error", () => {
    const r = parseAjax(
      '{"action":"list","exec":"this.display_message(\\"Your session is invalid or expired.\\",\\"error\\",-1000);\\nthis.session_error(\\"/?_task=login&_err=session\\");\\n"}',
    );
    expect(r.sessionExpired).toBe(true);
    expect(r.errors).toEqual(["Your session is invalid or expired."]);
  });

  test("message rows: missing `seen` means unread; hasnoattachment beats a multipart ctype", () => {
    const exec = [
      'this.set_unread_count("INBOX",577,true,"");',
      'this.add_message_row(1655,{"subject":"Student, your verification &amp; more","fromto":"<span class=\\"adr\\"><span title=\\"no-reply@researchgatemail.net\\" class=\\"rcmContactAddress\\">ResearchGate</span></span>","date":"Today 06:08","size":"19 KB"},{"hasnoattachment":1,"ctype":"multipart/alternative","mbox":"INBOX"},false);',
      'this.add_message_row(1656,{"subject":"probe","fromto":"<span class=\\"adr\\"><span title=\\"a@b.de\\" class=\\"rcmContactAddress\\">a@b.de</span></span>","date":"Today 22:34","size":"2 KB"},{"seen":1,"flagged":1,"ctype":"multipart/mixed","mbox":"INBOX","depth":1,"parent_uid":1655},false);',
    ].join("\n");
    const rows = messageRows(parseAjax(JSON.stringify({ action: "list", exec })), "INBOX");
    expect(rows.map((r) => [r.uid, r.seen, r.flagged, r.hasAttachment])).toEqual([
      [1655, false, false, false],
      [1656, true, true, true],
    ]);
    expect(rows[0]!.subject).toBe("Student, your verification & more");
    expect(rows[0]!.from).toEqual([{ name: "ResearchGate", email: "no-reply@researchgatemail.net" }]);
    expect(rows[1]!.depth).toBe(1);
    expect(rows[1]!.parentUid).toBe(1655);
  });

  test("all-folders search rows are keyed `<uid>-<folder id>`; uid and folder still come out right", () => {
    const exec = 'this.add_message_row("1654-SU5CT1g",{"subject":"x","fromto":"","date":"Sat 19:36","size":"8 KB"},{"mbox":"INBOX"},false);';
    const [row] = messageRows(parseAjax(JSON.stringify({ exec })), "Sent");
    expect([row!.uid, row!.mbox]).toEqual([1654, "INBOX"]);
  });

  test("confirmation messages are notices, not errors", () => {
    const r = parseAjax('{"exec":"this.display_message(\\"Successfully added access rights\\",\\"confirmation\\",0);\\n"}');
    expect(r.errors).toEqual([]);
    expect(r.notices).toEqual(["Successfully added access rights"]);
  });
});

describe("forms", () => {
  const compose = `
    <div id="compose-options">
      <input name="_mdn" id="compose-mdn" value="1" type="checkbox">
      <select name="_priority"><option value="5">Lowest</option><option value="0" selected>Normal</option></select>
    </div>
    <form name="form" method="post" action="/?_task=mail">
      <input type="hidden" name="_action" value="send">
      <select name="_from"><option value="1" selected>student@stud.th-deg.de</option></select>
      <textarea name="_message">&#10;&#10;On 2026-11-01, a wrote:&#10;&gt; quoted &amp; more</textarea>
      <input type="file" name="_attachments[]">
    </form>`;

  test("textarea content is entity-decoded like a browser submits it", () => {
    const form = parseForms(compose).find((f) => f.name === "form")!;
    expect(form.fields.find((f) => f.name === "_message")!.value).toBe("\n\nOn 2026-11-01, a wrote:\n> quoted & more");
  });

  test("Elastic's compose options live outside the form and are still found", () => {
    const orphans = parseForms(compose).find((f) => f.id === ORPHAN_FORM)!;
    expect(orphans.fields.map((f) => f.name)).toEqual(["_mdn", "_priority"]);
  });

  const prefs = `<form name="form">
    <input type="hidden" name="_section" value="mailbox">
    <input type="checkbox" name="_check_all_folders" value="1">
    <select name="_mail_read_time"><option value="-1">never</option><option value="0" selected>immediately</option></select>
    <input type="checkbox" name="_action_flags[0][]" value="\\Seen">
    <input type="checkbox" name="_action_flags[0][]" value="\\Flagged" checked>
    <input type="text" name="_x" disabled value="nope">
  </form>`;

  test("serialization omits unchecked boxes and disabled fields", () => {
    const fields = parseForms(prefs)[0]!.fields;
    expect(serializeForm(fields)).toEqual([
      ["_section", "mailbox"],
      ["_mail_read_time", "0"],
      ["_action_flags[0][]", "\\Flagged"],
    ]);
  });

  test("edits: checkbox on/off, select by label, checkbox groups by value list", () => {
    const fields = applyEdits(parseForms(prefs)[0]!.fields, { check_all_folders: "on", mail_read_time: "never", "action_flags[0][]": "\\Seen" });
    expect(serializeForm(fields)).toEqual([
      ["_section", "mailbox"],
      ["_check_all_folders", "1"],
      ["_mail_read_time", "-1"],
      ["_action_flags[0][]", "\\Seen"],
    ]);
  });

  test("edits reject unknown fields and invalid choices instead of silently doing nothing", () => {
    const fields = parseForms(prefs)[0]!.fields;
    expect(() => applyEdits(fields, { nosuch: "1" })).toThrow(/unknown field/);
    expect(() => applyEdits(fields, { mail_read_time: "7" })).toThrow(/must be one of/);
    expect(() => applyEdits(fields, { check_all_folders: "maybe" })).toThrow(/on or off/);
  });
});

test("vCards: folded lines are joined, types kept, empty values dropped", () => {
  const cards = parseVcards("BEGIN:VCARD\r\nVERSION:3.0\r\nN:;;;;\r\nFN:Test Twm\r\nEMAIL;TYPE=work:twm-test@exa\r\n mple.org\r\nNOTE:line1\\nline2\r\nEND:VCARD\r\n");
  expect(cards).toEqual([{ FN: ["Test Twm"], EMAIL: ["twm-test@example.org (work)"], NOTE: ["line1\nline2"] }]);
});
