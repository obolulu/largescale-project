/**
 * stderr logging in Python's `logging` format ("%(asctime)s %(levelname)s %(name)s: %(message)s"),
 * because stdout carries the MCP protocol in stdio mode.
 */

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

function asctime(d = new Date()): string {
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())},${pad(d.getMilliseconds(), 3)}`;
  return `${date} ${time}`;
}

export function getLogger(name: string) {
  const emit = (level: string, message: string): void => {
    process.stderr.write(`${asctime()} ${level} ${name}: ${message}\n`);
  };
  return {
    info: (message: string) => emit("INFO", message),
    error: (message: string) => emit("ERROR", message),
  };
}

const NON_PRINTABLE = /[\p{C}\p{Z}]/u;

/** Python's repr() of a str, e.g. 'extra internet price'. */
export function pyRepr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = "";
  for (const ch of s) {
    if (ch === quote || ch === "\\") out += "\\" + ch;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch !== " " && NON_PRINTABLE.test(ch)) {
      const cp = ch.codePointAt(0)!;
      out += cp < 0x100 ? `\\x${cp.toString(16).padStart(2, "0")}` : cp < 0x10000 ? `\\u${cp.toString(16).padStart(4, "0")}` : `\\U${cp.toString(16).padStart(8, "0")}`;
    } else out += ch;
  }
  return quote + out + quote;
}

/** Python's repr() of a list of str, e.g. ['8.1', '3.2']. */
export const pyListRepr = (items: string[]): string => `[${items.map(pyRepr).join(", ")}]`;
