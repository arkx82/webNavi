import { connect, type Socket } from "node:net";

/**
 * Just enough of Redis to hear Fleet Telemetry's pub/sub (its redis
 * dispatcher publishes each record on "<namespace>_<type>_{<VIN>}"): one
 * PSUBSCRIBE, the replies read as they come, the socket opened again when
 * it drops. No client library for one command.
 */
type Resp = string | number | Buffer | null | Resp[] | Error;

/** One reply from [buf] at [at]: the value and where the next begins, or null if it has not all come yet. */
export function parseResp(buf: Buffer, at = 0): [Resp, number] | null {
  if (at >= buf.length) return null;
  const eol = buf.indexOf("\r\n", at);
  if (eol < 0) return null;
  const type = String.fromCharCode(buf[at]);
  const line = buf.toString("utf8", at + 1, eol);
  const next = eol + 2;
  switch (type) {
    case "+": return [line, next];
    case "-": return [new Error(line), next];
    case ":": return [Number(line), next];
    case "$": {
      const len = Number(line);
      if (len < 0) return [null, next];
      if (buf.length < next + len + 2) return null;
      return [buf.subarray(next, next + len), next + len + 2];
    }
    case "*": {
      const n = Number(line);
      if (n < 0) return [null, next];
      const items: Resp[] = [];
      let p = next;
      for (let i = 0; i < n; i++) {
        const item = parseResp(buf, p);
        if (!item) return null;
        items.push(item[0]);
        p = item[1];
      }
      return [items, p];
    }
    default: throw new Error(`redis: unexpected reply type ${JSON.stringify(type)}`);
  }
}

function command(...args: string[]): string {
  return `*${args.length}\r\n${args.map((a) => `$${Buffer.byteLength(a)}\r\n${a}\r\n`).join("")}`;
}

export class RedisSubscriber {
  private socket: Socket | null = null;
  private buf: Buffer = Buffer.alloc(0);
  private running = false;
  private attempts = 0;
  private timer: NodeJS.Timeout | null = null;
  connected = false;
  lastError: string | null = null;

  constructor(
    private host: string,
    private port: number,
    private pattern: string,
    private onMessage: (channel: string, payload: Buffer) => void,
    private log: (m: string) => void = () => {},
    private password?: string,
  ) {}

  start() {
    if (this.running) return;
    this.running = true;
    this.open();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.socket?.destroy();
    this.socket = null;
  }

  private open() {
    const socket = connect({ host: this.host, port: this.port });
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    socket.setKeepAlive(true, 30_000);
    socket.on("connect", () => {
      if (this.password) socket.write(command("AUTH", this.password));
      socket.write(command("PSUBSCRIBE", this.pattern));
    });
    socket.on("data", (chunk) => this.data(chunk));
    socket.on("error", (e) => { this.lastError = e.message; });
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.connected = false;
      if (!this.running) return;
      const ms = Math.min(30_000, 1000 * 2 ** Math.min(5, this.attempts++));
      this.timer = setTimeout(() => this.open(), ms);
    });
  }

  private data(chunk: Buffer) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    let at = 0;
    for (;;) {
      let got: [Resp, number] | null;
      try {
        got = parseResp(this.buf, at);
      } catch (e) {
        this.log((e as Error).message);
        this.socket?.destroy();
        return;
      }
      if (!got) break;
      at = got[1];
      this.reply(got[0]);
    }
    this.buf = this.buf.subarray(at);
  }

  private reply(r: Resp) {
    if (r instanceof Error) { this.lastError = r.message; this.log(`redis: ${r.message}`); return; }
    if (!Array.isArray(r)) return;
    const kind = Buffer.isBuffer(r[0]) ? r[0].toString() : r[0];
    if (kind === "psubscribe") { this.connected = true; this.attempts = 0; this.lastError = null; return; }
    if (kind === "pmessage" && Buffer.isBuffer(r[2]) && Buffer.isBuffer(r[3])) this.onMessage(r[2].toString(), r[3]);
  }
}
