/** Argument parsing and output plumbing shared by every `thd` frontend. */

/** Bad invocation: exit 64 (EX_USAGE) before any network work. */
export class UsageError extends Error {}

/** A service needs a sign-in the CLI could not complete on its own: exit 2. */
export class LoginRequired extends Error {}

export interface Globals {
  json: boolean;
  quiet: boolean;
}

const tty = () => Boolean(process.stdout.isTTY);
const paint = (code: number) => (s: string) => (tty() ? `\x1b[${code}m${s}\x1b[0m` : s);
export const A = { g: paint(32), r: paint(31), y: paint(33), d: paint(90), b: paint(1) };

export function makeIO(g: Globals) {
  return {
    log: (m: string) => g.quiet || console.error(m),
    out: (data: unknown, human: () => string) => {
      if (g.json) console.log(JSON.stringify(data, null, 2));
      else {
        const text = human();
        if (text) console.log(text);
      }
    },
  };
}

export function pullFlag(args: string[], ...names: string[]): boolean {
  let found = false;
  for (const n of names) {
    let i: number;
    while ((i = args.indexOf(n)) >= 0) {
      args.splice(i, 1);
      found = true;
    }
  }
  return found;
}

/** Every value of a repeatable `--flag value` / `--flag=value`. */
export function pullVals(args: string[], ...names: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; ) {
    const a = args[i]!;
    const n = names.find((n) => a === n || a.startsWith(`${n}=`));
    if (!n) {
      i++;
      continue;
    }
    if (a.startsWith(`${n}=`)) {
      out.push(a.slice(n.length + 1));
      args.splice(i, 1);
      continue;
    }
    const next = args[i + 1];
    if (next === undefined) throw new UsageError(`${n} needs a value`);
    out.push(next);
    args.splice(i, 2);
  }
  return out;
}

export const pullVal = (args: string[], ...names: string[]): string | undefined => pullVals(args, ...names).at(-1);

export function pullInt(args: string[], def: number, ...names: string[]): number {
  const v = pullVal(args, ...names);
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`${names.at(-1)} needs an integer >= 1 (got '${v}')`);
  return n;
}

export function rejectStray(args: string[]): void {
  const stray = args.find((a) => /^--?[a-zA-Z]/.test(a));
  if (stray) throw new UsageError(`unknown flag ${stray}`);
}

export function need<T>(v: T | undefined, what: string): T {
  if (v === undefined || v === "") throw new UsageError(`missing ${what}`);
  return v;
}

export async function readStdin(): Promise<string> {
  return await new Response(Bun.stdin.stream()).text();
}
