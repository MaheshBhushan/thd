import { homedir } from "node:os";
import { join } from "node:path";

/** All state (sessions, iLearn token, browser profile): $THD_HOME or ~/.local/share/thd. */
export function stateDir(): string {
  if (process.env.THD_HOME) return process.env.THD_HOME;
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "thd");
}
