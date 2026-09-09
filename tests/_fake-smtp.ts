/**
 * Minimal plaintext SMTP server for tests: accepts everything, records each
 * message's envelope + DATA. No TLS, no AUTH (nodemailer only sends AUTH when
 * the server advertises it, and it falls back to plaintext when STARTTLS is
 * not advertised).
 */

export interface FakeSmtpMessage {
	from: string;
	to: string[];
	data: string;
}

export interface FakeSmtpServer {
	port: number;
	messages: FakeSmtpMessage[];
	/**
	 * Decide per message whether to reject it with a transient 451 at the
	 * `DATA` terminator. Default: accept everything.
	 */
	failIf: (envelope: { from: string; to: string[] }) => boolean;
	close(): Promise<void>;
}

export function startFakeSmtp(): FakeSmtpServer {
	const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
	const port = (listener.addr as Deno.NetAddr).port;
	const messages: FakeSmtpMessage[] = [];
	const server: FakeSmtpServer = { port, messages, failIf: () => false, close };
	const conns = new Set<Deno.Conn>();
	const enc = new TextEncoder();
	const dec = new TextDecoder();

	async function handle(conn: Deno.Conn): Promise<void> {
		conns.add(conn);
		const write = (s: string) => conn.write(enc.encode(s + "\r\n"));
		let buf = "";
		let inData = false;
		let from = "";
		let to: string[] = [];
		let data: string[] = [];
		try {
			await write("220 fake.test ESMTP");
			const chunk = new Uint8Array(4096);
			while (true) {
				const n = await conn.read(chunk);
				if (n === null) break;
				buf += dec.decode(chunk.subarray(0, n));
				let idx: number;
				while ((idx = buf.indexOf("\r\n")) >= 0) {
					const line = buf.slice(0, idx);
					buf = buf.slice(idx + 2);
					if (inData) {
						if (line === ".") {
							inData = false;
							if (server.failIf({ from, to })) {
								await write("451 4.3.0 Temporary failure, try again");
							} else {
								messages.push({ from, to, data: data.join("\r\n") });
								await write("250 2.0.0 OK queued");
							}
							from = "";
							to = [];
							data = [];
						} else {
							data.push(line.startsWith("..") ? line.slice(1) : line);
						}
						continue;
					}
					const cmd = line.split(" ")[0].toUpperCase();
					switch (cmd) {
						case "EHLO":
							await write("250-fake.test\r\n250 8BITMIME");
							break;
						case "HELO":
							await write("250 fake.test");
							break;
						case "MAIL":
							from = line.slice(line.indexOf(":") + 1).trim();
							await write("250 2.1.0 OK");
							break;
						case "RCPT":
							to.push(line.slice(line.indexOf(":") + 1).trim());
							await write("250 2.1.5 OK");
							break;
						case "DATA":
							inData = true;
							await write("354 End data with <CR><LF>.<CR><LF>");
							break;
						case "RSET":
							from = "";
							to = [];
							data = [];
							await write("250 2.0.0 OK");
							break;
						case "NOOP":
							await write("250 2.0.0 OK");
							break;
						case "QUIT":
							await write("221 2.0.0 Bye");
							conn.close();
							conns.delete(conn);
							return;
						default:
							await write("502 5.5.2 Command not implemented");
					}
				}
			}
		} catch {
			// connection reset etc. — fine for a test double
		} finally {
			try {
				conn.close();
			} catch { /* already closed */ }
			conns.delete(conn);
		}
	}

	(async () => {
		try {
			for await (const conn of listener) handle(conn);
		} catch { /* listener closed */ }
	})();

	async function close(): Promise<void> {
		for (const c of conns) {
			try {
				c.close();
			} catch { /* ignore */ }
		}
		listener.close();
		// Give in-flight handlers a tick to observe the close.
		await new Promise((r) => setTimeout(r, 10));
	}

	return server;
}
