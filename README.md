# thd

THD webmail (`webmail.stud.th-deg.de`, Roundcube 1.6.20) and iLearn (`ilearn.th-deg.de`, Moodle 4.5) in one command-line tool. It sends the same requests as the web UI and the Moodle app, so it can do what a signed-in student can do in either. Unofficial; not affiliated with or endorsed by TH Deggendorf.

```bash
git clone https://github.com/MaheshBhushan/thd && cd thd
bun install && bun link      # needs Bun (bun.sh) and Chrome/Chromium; puts `thd` on PATH
thd login                    # once; a window opens if Microsoft needs you
thd today                    # deadlines + unread iLearn activity + unread mail
thd --help                   # thd mail help · thd ilearn help
```

## Sign-in

Both services end at THD's Microsoft Entra tenant. Webmail sends you there directly. iLearn goes through Shibboleth (`idp.th-deg.de`), whose tenant router forwards students to Microsoft. `thd` keeps one Chrome profile in `~/.local/share/thd/chrome-profile`, so one Microsoft sign-in covers both. Choose **Stay signed in**. After that, every sign-in runs headless in 2–4 s:

- **Webmail:** the Roundcube session expires after 10 idle minutes. The next command signs in again and retries once.
- **iLearn:** the browser reaches Moodle, and its `MoodleSession` cookie mints the mobile-app token (`admin/tool/mobile/launch.php`, 12 weeks valid). Signing in again before expiry returns the same token. An expired or revoked token triggers one automatic sign-in and a retry.
- If Microsoft wants input and there is no terminal or display, commands exit with **2**. Run `thd login` in a graphical session.

`thd login mail --cookie` and `thd login ilearn --cookie` take a pasted `Cookie:` header or `MoodleSession` value on stdin instead of using the browser. `THD_TENANT` overrides the tenant router's choice (default `stud`).

Exit codes: 0 ok · 1 error · 2 sign-in needed · 64 bad usage.

## Combined commands

```bash
thd today [--days 7]          # iLearn deadlines, unread notifications/messages, unread mail this week
thd link UID                  # an iLearn forum mail → the forum discussion posts it announces
thd link UID                  # a due-date reminder → that assignment's submission status
thd link --course statistics  # all mails about a course (subject/body match, all folders)
```

iLearn notification mails come from `no-reply@th-deg.de` with a Message-ID at `ilearn.th-deg.de`. Forum mails carry `X-Course-Id`/`X-Course-Name` and link `mod/forum/discuss.php?d=<id>#p<post>`. Reminders link `mod/assign/view.php?id=<cmid>`. `thd link` reads the message with `--peek` (it stays unread) and resolves those links through the Moodle API.

## Webmail (`thd mail …`)

Read, search (fields, flags, age, all folders), threads, raw source and attachments, flags, move/copy/delete/archive, empty/compact, import `.eml/.mbox`, zip export, send/reply/forward/drafts/redirect with attachments and options, contacts including the THD directory, preferences, identity, canned responses, folders, folder sharing, and server-side filters (form editing or raw Sieve).

Settings screens are edited generically. `thd mail prefs compose` lists the fields with their values and choices, and `thd mail prefs compose reply_mode=1` changes one. Checkboxes take on/off, selects take a value or label, checkbox groups take a comma list, and `FIELD=@file` reads a file. Unknown fields and invalid choices are rejected. `--sort` and `--threads` save server-side preferences, as in the UI (`--sort none` restores the default).

| UI action | Request |
|---|---|
| Any AJAX call | `GET/POST /?_task=T&_action=A&_remote=1`, header `X-Roundcube-Request: <token>` → JSON `{action, env, texts, exec}`; `exec` is `this.method(json…);` lines |
| Session expired | AJAX: `this.session_error(...)`; pages: login page or 302 to `login.microsoftonline.com` |
| Message list | `mail/list` `_mbox,_page[,_sort=col_ORDER][,_threads]` → `add_message_row(uid, cols, flags)`; all-folder rows are `"<uid>-<folder id>"` |
| Search / filter | `mail/search` `_q,_headers,_filter,_scope,_interval,_mbox` → `env.search_request`; next pages `list&_search=<id>` |
| Raw message / downloads | `GET mail/viewsource&_uid&_mbox&_token`; every download needs `_token` or fails the CSRF check |
| Flags | `POST mail/mark` `_uid=1,2|*,_flag=read|unread|flagged|unflagged|delete|undelete,_mbox` |
| Move / copy / delete / archive | `POST mail/move|copy` `_uid,_mbox,_target_mbox`; `mail/delete`; `mail/plugin.move2archive` |
| Empty / compact | `POST mail/purge|expunge` `_mbox` |
| Redirect | `GET mail/bounce&_framed=1` (allocates `_id`), then `POST mail/bounce` with that form plus `_uid,_mbox,_to` |
| Import / zip export | multipart `POST mail/import&_remote=1` `_file[]`; `POST mail/plugin.zipdownload.messages` `_uid,_mbox,_mode,_token` |
| Compose | `GET mail/compose[&_reply_uid|_forward_uid|_draft_uid|_uid,&_mbox,&_all,&_attachment]` → 302 `&_id=<compose_id>` |
| Attach | multipart `POST mail/upload&_id&_uploadid&_from=compose&_remote=1` `_attachments[]` → `add2attachment_list("rcmfile<id>")` |
| Send / save draft | `POST /?_task=mail&_unlock&_framed=1`: form fields + `_action=send`, `_attachments=<ids>`, compose options copied in as hidden fields, `_draft=1` for drafts |
| Contacts | `addressbook/list|search` → `add_contact_row(...)`; search ids `<cid>-<source>`; `export&_token` (vCard); `add|edit&_framed=1` → `save`; `delete|copy|move|group-*` |
| Settings | `edit-prefs&_section` → `save-prefs`; `edit-identity` → `save-identity`; `add/edit-response` → `save-response`; `edit-folder` → `save-folder`; `delete-folder`, `subscribe`, `folder-size` |
| Sharing (acl) | `POST settings/plugin.acl` `_act=save|delete,_user,_acl,_mbox`; the server refuses `anyone` |
| Filters (managesieve) | `plugin.managesieve-action` `_act=list|act|delete|move|setact|deact|setdel`; editor → `plugin.managesieve-save`; raw `_seteditraw=1` → `plugin.managesieve-saveraw` |

Limits: 22 MB / 20 files per upload, 10-minute idle session, identity level 3 (one identity, address fixed).

## iLearn (`thd ilearn …`)

Courses, resumable file downloads, deadlines, assignments and submissions (draft by default, `--final` submits), grades, notifications, messages, forums and discussions. `thd ilearn call <wsfunction> k=v…` reaches all ~450 functions the Moodle app may call, and `thd ilearn functions FILTER` lists them.

| Layer | Endpoint | Auth |
|---|---|---|
| Web services (used here) | `POST /webservice/rest/server.php` `wsfunction=…&moodlewsrestformat=json` | `wstoken` |
| Token file access | `GET /webservice/pluginfile.php/…?token=` | `wstoken` |
| Upload | `POST /webservice/upload.php` (multipart `file_1`, `filearea=draft`, `itemid`) | `token` field |
| Token minting | `admin/tool/mobile/launch.php?service=moodle_mobile_app&passport=N&urlscheme=moodlemobile` → `302 moodlemobile://token=<base64 md5(site+passport):::wstoken:::private>` | `MoodleSession` |

WS calls return HTTP 200 on failure with `{exception, errorcode, message}`. An expired token surfaces as a bare `accessexception`, so the client confirms it with `core_webservice_get_site_info` first. Parameters are PHP-style keys (`courseids[0]=5`) and booleans are `1`/`0`. The token's expiry comes from `/user/managetoken.php`. The token is shared with the phone's Moodle app: resetting it there logs the app out.

## Responsible use

iLearn's "Rechte und Pflichten" apply to anything fetched. Course materials stay private. Other users' data is confidential. The account and its tokens are personal: never share `~/.local/share/thd` or run the tool for someone else. Requests go one at a time. Avoid bulk downloads in tight loops.

## Development

```bash
bun run check     # typecheck + tests
```

`browser.ts` owns Chrome and the shared sign-in. `mail/client.ts` and `ilearn/moodle.ts` own HTTP for their service. `links.ts`, `today.ts` and the top-level `cli.ts` hold the combined features. `mail/protocol.ts`, `mail/render.ts` and `links.ts#mailLinks` are pure.

## License

MIT, see [LICENSE](LICENSE).
