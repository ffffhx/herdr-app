// Codex's control socket uses WebSocket over `codex app-server proxy` stdio,
// not JSONL. This client needs no TCP listener or third-party Node packages.
import { createHash, randomBytes } from "node:crypto";

const LIMIT = 16 * 1024 * 1024;
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function clientFrame(opcode, payload) {
  payload = Buffer.from(payload);
  if (payload.length > LIMIT) throw new Error("Codex WebSocket message is too large");
  const extra = payload.length < 126 ? 0 : payload.length <= 65535 ? 2 : 8;
  const header = Buffer.alloc(2 + extra + 4), mask = randomBytes(4);
  header[0] = 0x80 | opcode; header[1] = 0x80 | (extra === 0 ? payload.length : extra === 2 ? 126 : 127);
  if (extra === 2) header.writeUInt16BE(payload.length, 2);
  if (extra === 8) header.writeBigUInt64BE(BigInt(payload.length), 2);
  mask.copy(header, 2 + extra);
  const data = Buffer.alloc(payload.length);
  for (let n = 0; n < payload.length; n++) data[n] = payload[n] ^ mask[n % 4];
  return Buffer.concat([header, data]);
}

export function websocket(input, output, { message, error }) {
  const key = randomBytes(16).toString("base64");
  const accept = createHash("sha1").update(key + GUID).digest("base64");
  let ready = false, ended = false, bytes = Buffer.alloc(0), chunks = [], size = 0, fragment = false;
  const waiting = [];
  const write = (op, data) => output.write(clientFrame(op, data));
  const fail = reason => { if (ended) return; ended = true; clearTimeout(timer); error(reason); output.end(); };
  const timer = setTimeout(() => fail(new Error("Codex daemon WebSocket handshake timed out")), 10000);
  output.write(`GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n\r\n`);
  input.on("data", data => {
    if (ended) return;
    try {
      bytes = Buffer.concat([bytes, data]);
      if (!ready) {
        const end = bytes.indexOf("\r\n\r\n");
        if (end < 0) { if (bytes.length > 16384) throw new Error("Invalid Codex WebSocket handshake"); return; }
        const headers = bytes.subarray(0, end).toString("ascii");
        const fields = new Map(headers.split("\r\n").slice(1).map(line => { const p = line.indexOf(":"); return [line.slice(0, p).toLowerCase(), line.slice(p + 1).trim()]; }));
        if (!/^HTTP\/1\.1 101\b/.test(headers) || fields.get("sec-websocket-accept") !== accept || fields.get("upgrade")?.toLowerCase() !== "websocket") throw new Error("Codex daemon refused the WebSocket connection");
        ready = true; clearTimeout(timer); bytes = bytes.subarray(end + 4);
        for (const value of waiting.splice(0)) write(1, value);
      }
      while (bytes.length >= 2) {
        const fin = Boolean(bytes[0] & 0x80), op = bytes[0] & 15;
        if (bytes[0] & 0x70 || bytes[1] & 0x80) throw new Error("Invalid Codex WebSocket frame");
        let length = bytes[1] & 127, offset = 2;
        if (length === 126) { if (bytes.length < 4) return; length = bytes.readUInt16BE(2); offset = 4; }
        if (length === 127) { if (bytes.length < 10) return; const large = bytes.readBigUInt64BE(2); if (large > BigInt(LIMIT)) throw new Error("Codex WebSocket frame is too large"); length = Number(large); offset = 10; }
        if (length > LIMIT || (op >= 8 && (!fin || length > 125))) throw new Error("Invalid Codex WebSocket frame size");
        if (bytes.length < offset + length) return;
        const payload = bytes.subarray(offset, offset + length); bytes = bytes.subarray(offset + length);
        if (op === 8) { ended = true; write(8, payload); output.end(); return; }
        if (op === 9) { write(10, payload); continue; }
        if (op === 10) continue;
        if ((op !== 0 && op !== 1) || (op === 0 && !fragment) || (op === 1 && fragment)) throw new Error("Unexpected Codex WebSocket message");
        chunks.push(payload); size += payload.length;
        if (size > LIMIT) throw new Error("Codex WebSocket message is too large");
        fragment = !fin;
        if (fin) {
          const value = JSON.parse(Buffer.concat(chunks, size).toString("utf8")); chunks = []; size = 0;
          Promise.resolve(message(value)).catch(fail);
        }
      }
    } catch (reason) { fail(reason); }
  });
  input.on("end", () => { clearTimeout(timer); ended = true; });
  return {
    send(value) { if (ended) throw new Error("Codex daemon connection is closed"); const text = JSON.stringify(value); if (ready) write(1, text); else waiting.push(text); },
    close() { clearTimeout(timer); if (ended) return; ended = true; if (ready) write(8, Buffer.alloc(0)); output.end(); },
  };
}
