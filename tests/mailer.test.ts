/** Outgoing email: SMTP when it is set up, Resend otherwise, nothing when neither. The SMTP client is tested against a small SMTP server of its own. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import tls from "node:tls";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addressOf, buildMime, mailTransport, sendMail, smtpConfig } from "@/lib/mailer.server";

interface Mock {
  port: number;
  mails: Array<{ from: string; to: string[]; data: string }>;
  commands: string[];
  close: () => Promise<void>;
}

/** A minimal SMTP server on a local port. `auth` lists what it offers; a wrong password gets 535; `rejectRcpt` refuses every recipient. */
async function mockSmtp(opts: { auth?: "PLAIN LOGIN" | "LOGIN"; user?: string; pass?: string; rejectRcpt?: boolean; tls?: "ssl" | "starttls"; cert?: { key: string; cert: string } } = {}): Promise<Mock> {
  const mails: Mock["mails"] = [];
  const commands: string[] = [];
  const user = opts.user ?? "divieight@example.test";
  const pass = opts.pass ?? "s3cret";
  const handle = (sock: net.Socket | tls.TLSSocket, greet: boolean, secured: boolean) => {
    sock.setEncoding("utf8");
    let buf = "";
    let mode: "cmd" | "login-user" | "login-pass" | "data" = "cmd";
    let cur: { from: string; to: string[]; data: string } = { from: "", to: [], data: "" };
    if (greet) sock.write("220 mock ESMTP\r\n");
    sock.on("data", (chunk: string) => {
      buf += chunk;
      if (mode === "data") {
        const end = buf.indexOf("\r\n.\r\n");
        if (end < 0) return;
        cur.data = buf.slice(0, end);
        buf = buf.slice(end + 5);
        mails.push(cur);
        cur = { from: "", to: [], data: "" };
        mode = "cmd";
        sock.write("250 queued\r\n");
      }
      let i: number;
      while (mode !== "data" && (i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (mode === "login-user") {
          mode = "login-pass";
          sock.write("334 UGFzc3dvcmQ6\r\n");
          continue;
        }
        if (mode === "login-pass") {
          mode = "cmd";
          sock.write(Buffer.from(line, "base64").toString() === pass ? "235 ok\r\n" : "535 bad credentials\r\n");
          continue;
        }
        commands.push(line.startsWith("AUTH") ? line.split(" ").slice(0, 2).join(" ") : line.replace(/<[^>]*>/, "<…>"));
        if (/^EHLO/i.test(line)) {
          // With STARTTLS the server offers STARTTLS and refuses to log anyone in until the line is encrypted.
          const offerTls = opts.tls === "starttls" && !secured;
          sock.write(`250-mock\r\n${offerTls ? "250-STARTTLS\r\n" : opts.auth === "LOGIN" ? "250-AUTH LOGIN\r\n" : "250-AUTH PLAIN LOGIN\r\n"}250 8BITMIME\r\n`);
        } else if (/^STARTTLS/i.test(line)) {
          sock.write("220 ready\r\n");
          sock.removeAllListeners("data");
          const wrapped = new tls.TLSSocket(sock as net.Socket, { isServer: true, secureContext: tls.createSecureContext(opts.cert!) });
          handle(wrapped, false, true);
          return;
        }
        else if (/^AUTH PLAIN /i.test(line)) {
          const [, u, p] = Buffer.from(line.slice(11), "base64").toString().split("\0");
          sock.write(u === user && p === pass ? "235 ok\r\n" : "535 bad credentials\r\n");
        } else if (/^AUTH LOGIN/i.test(line)) {
          mode = "login-user";
          sock.write("334 VXNlcm5hbWU6\r\n");
        } else if (/^MAIL FROM:/i.test(line)) {
          cur.from = /<([^>]*)>/.exec(line)![1]!;
          sock.write("250 ok\r\n");
        } else if (/^RCPT TO:/i.test(line)) {
          if (opts.rejectRcpt) sock.write("550 no such user\r\n");
          else {
            cur.to.push(/<([^>]*)>/.exec(line)![1]!);
            sock.write("250 ok\r\n");
          }
        } else if (/^DATA/i.test(line)) {
          mode = "data";
          sock.write("354 go ahead\r\n");
          if (buf.length) sock.emit("data", "");
        } else if (/^QUIT/i.test(line)) sock.end("221 bye\r\n");
        else sock.write("502 not implemented\r\n");
      }
    });
    sock.on("error", () => undefined);
  };
  const server = opts.tls === "ssl" ? tls.createServer(opts.cert!, (sock) => handle(sock, true, true)) : net.createServer((sock) => handle(sock, true, false));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as net.AddressInfo).port;
  return { port, mails, commands, close: () => new Promise((r) => server.close(() => r())) };
}

const env = (port: number, over: Record<string, string> = {}) => ({ SMTP_HOST: "127.0.0.1", SMTP_PORT: String(port), SMTP_USER: "divieight@example.test", SMTP_PASS: "s3cret", SMTP_SECURE: "none", ...over });
/** The text of one MIME part, decoded. */
const part = (raw: string, type: string) => {
  const m = new RegExp(`Content-Type: ${type};[^\\n]*\\r\\nContent-Transfer-Encoding: base64\\r\\n\\r\\n([\\s\\S]*?)\\r\\n--`, "i").exec(raw);
  return m ? Buffer.from(m[1]!.replace(/\r\n/g, ""), "base64").toString("utf8") : null;
};

let mock: Mock | null = null;
afterEach(async () => {
  await mock?.close();
  mock = null;
  vi.restoreAllMocks();
});

describe("which way an email goes", () => {
  it("SMTP when host, user and password are set; Resend when only its key is; nothing otherwise", () => {
    expect(mailTransport({ SMTP_HOST: "mail.x", SMTP_USER: "u@x", SMTP_PASS: "p" })).toBe("smtp");
    expect(mailTransport({ SMTP_HOST: "mail.x", SMTP_USER: "u@x", SMTP_PASS: "p", RESEND_API_KEY: "k" })).toBe("smtp");
    expect(mailTransport({ RESEND_API_KEY: "k" })).toBe("resend");
    expect(mailTransport({ SMTP_HOST: "mail.x", SMTP_USER: "u@x" })).toBe("none");
    expect(mailTransport({})).toBe("none");
  });

  it("defaults: port 465 is implicit TLS, another port is STARTTLS, and the sender is the mailbox", () => {
    expect(smtpConfig({ SMTP_HOST: "mail.x", SMTP_USER: "u@x.com", SMTP_PASS: "p" })).toMatchObject({ port: 465, secure: "ssl", from: "divieight <u@x.com>" });
    expect(smtpConfig({ SMTP_HOST: "mail.x", SMTP_USER: "u@x.com", SMTP_PASS: "p", SMTP_PORT: "587" })).toMatchObject({ port: 587, secure: "starttls" });
    expect(smtpConfig({ SMTP_HOST: "mail.x", SMTP_USER: "u@x.com", SMTP_PASS: "p", SMTP_FROM: "Divieight <hello@x.com>" })?.from).toBe("Divieight <hello@x.com>");
  });

  it("nothing is sent, and the caller is told, when no transport is set up", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await sendMail({ to: "a@b.c", subject: "x", text: "y" }, {})).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("Resend is still used when SMTP is not set up", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    expect(await sendMail({ to: "a@b.c", subject: "Hello", html: "<p>Hi</p>" }, { RESEND_API_KEY: "k" })).toBe(true);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe("https://api.resend.com/emails");
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({ to: ["a@b.c"], subject: "Hello", html: "<p>Hi</p>" });
  });
});

describe("the message", () => {
  it("is a text and an HTML version, with a plain From, To, Subject and Message-ID", () => {
    const { raw } = buildMime({ to: ["a@b.c", "d@e.f"], subject: "Your steps", html: "<p>Hello <b>there</b></p><a href=\"https://x.test/go\">Open</a>" }, "divieight <divieight@example.test>", "example.test");
    expect(raw).toMatch(/^From: divieight <divieight@example\.test>\r\n/);
    expect(raw).toContain("To: a@b.c, d@e.f\r\n");
    expect(raw).toContain("Subject: Your steps\r\n");
    expect(raw).toMatch(/Message-ID: <[0-9a-f]{24}@example\.test>/);
    expect(raw).toContain("multipart/alternative");
    expect(part(raw, "text/html")).toBe("<p>Hello <b>there</b></p><a href=\"https://x.test/go\">Open</a>");
    expect(part(raw, "text/plain")).toContain("Hello there");
    expect(part(raw, "text/plain")).toContain("Open (https://x.test/go)");
  });

  it("encodes a subject or a sender name with non-ASCII text, and a plain text message has no HTML part", () => {
    const { raw } = buildMime({ to: "a@b.c", subject: "Ahmad’s €100 notice", text: "plain" }, "Dív <d@example.test>", "example.test");
    expect(raw).toMatch(/^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=\r\n/m);
    expect(raw).toMatch(/^From: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <d@example\.test>/m);
    expect(raw).not.toContain("text/html");
    expect(raw).toContain("plain".length ? Buffer.from("plain").toString("base64") : "");
  });

  it("a subject cannot inject another header", () => {
    const { raw } = buildMime({ to: "a@b.c", subject: "Hi\r\nBcc: evil@x.test", text: "t" }, "d@example.test", "example.test");
    expect(raw).not.toMatch(/^Bcc:/m);
  });

  it("takes the bare address out of a display name", () => {
    expect(addressOf("divieight <d@example.test>")).toBe("d@example.test");
    expect(addressOf("d@example.test")).toBe("d@example.test");
  });
});

describe("over SMTP", () => {
  it("logs in (AUTH PLAIN), hands over the sender, every recipient and the message, and says it was accepted", async () => {
    mock = await mockSmtp();
    const ok = await sendMail({ to: ["a@b.c", "d@e.f"], subject: "Sign your agreement", html: "<p>Open <a href=\"https://divieight.vercel.app/x\">your dashboard</a></p>" }, env(mock.port));
    expect(ok).toBe(true);
    expect(mock.mails).toHaveLength(1);
    expect(mock.mails[0]).toMatchObject({ from: "divieight@example.test", to: ["a@b.c", "d@e.f"] });
    expect(mock.mails[0]!.data).toContain("Subject: Sign your agreement");
    expect(part(mock.mails[0]!.data, "text/html")).toContain("https://divieight.vercel.app/x");
    expect(mock.commands.slice(0, 2)).toEqual(["EHLO example.test", "AUTH PLAIN"]);
    expect(mock.commands).toContain("QUIT");
  });

  it("falls back to AUTH LOGIN when the server offers only that", async () => {
    mock = await mockSmtp({ auth: "LOGIN" });
    expect(await sendMail({ to: "a@b.c", subject: "x", text: "y" }, env(mock.port))).toBe(true);
    expect(mock.commands).toContain("AUTH LOGIN");
    expect(mock.mails).toHaveLength(1);
  });

  it("uses SMTP_FROM for the sender shown and the bare address for the envelope", async () => {
    mock = await mockSmtp();
    await sendMail({ to: "a@b.c", subject: "x", text: "y" }, env(mock.port, { SMTP_FROM: "divieight Support <support@example.test>" }));
    expect(mock.mails[0]!.from).toBe("support@example.test");
    expect(mock.mails[0]!.data).toContain("From: divieight Support <support@example.test>");
  });

  it("a wrong password is refused and reported as not sent, without the password or the address in the log", async () => {
    mock = await mockSmtp();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await sendMail({ to: "secret.person@b.c", subject: "x", text: "y" }, env(mock.port, { SMTP_PASS: "wrong" }))).toBe(false);
    expect(mock.mails).toHaveLength(0);
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).toContain("auth");
    expect(logged).toContain("535");
    expect(logged).not.toContain("wrong");
    expect(logged).not.toContain("secret.person");
  });

  it("a refused recipient is reported as not sent", async () => {
    mock = await mockSmtp({ rejectRcpt: true });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await sendMail({ to: "nobody@b.c", subject: "x", text: "y" }, env(mock.port))).toBe(false);
    expect(mock.mails).toHaveLength(0);
  });

  it("an unreachable server is reported as not sent, never thrown", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await sendMail({ to: "a@b.c", subject: "x", text: "y" }, env(1))).toBe(false);
  });

  it("a message whose text has a line starting with a dot arrives whole", async () => {
    mock = await mockSmtp();
    await sendMail({ to: "a@b.c", subject: "x", text: "line one\n.\n.hidden\nend" }, env(mock.port));
    expect(part(mock.mails[0]!.data, "text/plain") ?? Buffer.from(mock.mails[0]!.data.split("\r\n\r\n").slice(1).join("").replace(/\r\n/g, ""), "base64").toString()).toContain(".hidden");
  });
});

describe("nothing else sends mail by itself any more", () => {
  it("every email path goes through the one mailer", async () => {
    const { readFileSync } = await import("node:fs");
    for (const f of ["src/lib/authorization.notify.server.ts", "src/lib/notifications.functions.ts", "src/lib/designation.functions.ts", "src/lib/enrollment-maintenance.functions.ts"]) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toContain("api.resend.com");
      expect(src, f).toMatch(/sendMail|mailer\.server/);
    }
  });
});

describe("over TLS (the real thing: port 465, and STARTTLS on 587)", () => {
  // A throw-away certificate for the test server. The client's certificate check is switched off for these two tests only, because the certificate is self-signed.
  let dir = "";
  let cert: { key: string; cert: string } | null = null;
  try {
    dir = mkdtempSync(join(tmpdir(), "mailer-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "1", "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
    cert = { key: readFileSync(join(dir, "k.pem"), "utf8"), cert: readFileSync(join(dir, "c.pem"), "utf8") };
  } catch {
    cert = null;
  }
  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  beforeEach(() => {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
  });
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(!cert)("implicit TLS (port 465): connects encrypted, logs in and sends", async () => {
    mock = await mockSmtp({ tls: "ssl", cert: cert! });
    expect(await sendMail({ to: "a@b.c", subject: "Over TLS", html: "<p>Encrypted</p>" }, env(mock.port, { SMTP_SECURE: "ssl" }))).toBe(true);
    expect(mock.mails).toHaveLength(1);
    expect(mock.mails[0]).toMatchObject({ from: "divieight@example.test", to: ["a@b.c"] });
    expect(part(mock.mails[0]!.data, "text/html")).toBe("<p>Encrypted</p>");
  });

  it.skipIf(!cert)("STARTTLS (port 587): upgrades the line first, and only then logs in", async () => {
    mock = await mockSmtp({ tls: "starttls", cert: cert! });
    expect(await sendMail({ to: "a@b.c", subject: "Upgraded", text: "hello" }, env(mock.port, { SMTP_SECURE: "starttls" }))).toBe(true);
    expect(mock.mails).toHaveLength(1);
    // STARTTLS came before AUTH, and EHLO was said again over the encrypted line.
    const i = mock.commands.indexOf("STARTTLS");
    expect(i).toBeGreaterThan(0);
    expect(mock.commands.filter((c) => c === "EHLO example.test")).toHaveLength(2);
    expect(mock.commands.indexOf("AUTH PLAIN")).toBeGreaterThan(i);
  });

  it.skipIf(!cert)("a wrong password over TLS is refused too", async () => {
    mock = await mockSmtp({ tls: "ssl", cert: cert! });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await sendMail({ to: "a@b.c", subject: "x", text: "y" }, env(mock.port, { SMTP_SECURE: "ssl", SMTP_PASS: "nope" }))).toBe(false);
    expect(mock.mails).toHaveLength(0);
  });
});
