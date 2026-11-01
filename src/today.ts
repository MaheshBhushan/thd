/** `thd today`: iLearn deadlines and unread iLearn/mail activity in one view. */
import type { Client } from "./mail/client.ts";
import * as mail from "./mail/mail.ts";
import type { MessageRow } from "./mail/protocol.ts";
import type { IlearnClient } from "./ilearn/cli.ts";
import * as core from "./ilearn/core.ts";

export interface IlearnToday {
  deadlines: core.Deadline[];
  unreadNotifications: number;
  unreadMessages: number;
}

export interface MailToday {
  unread: number;
  rows: (MessageRow & { ilearn: boolean })[];
}

export async function ilearnToday(c: IlearnClient, days: number): Promise<IlearnToday> {
  const userid = await c.userid();
  const [deadlines, notes, convs] = await Promise.all([
    core.deadlines(c.m, days),
    core.notifications(c.m, userid, 1),
    core.conversations(c.m, userid, 50),
  ]);
  return { deadlines, unreadNotifications: notes.unread, unreadMessages: convs.reduce((n, x) => n + x.unread, 0) };
}

/** Unread INBOX mail of the last week (Roundcube's shortest age filter), newest first. */
export async function mailToday(c: Client, limit: number): Promise<MailToday> {
  const r = await mail.list(c, { mbox: "INBOX", filter: "UNSEEN", interval: "1W" });
  return {
    unread: r.total,
    rows: r.rows.slice(0, limit).map((row) => ({ ...row, ilearn: row.from.some((a) => /^no-reply@th-deg\.de$/i.test(a.email)) })),
  };
}
