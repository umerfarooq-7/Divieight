/**
 * Outgoing email (server-only). One place every email goes through.
 *
 *   1. SMTP, when SMTP_HOST, SMTP_USER and SMTP_PASS are set (for example the cPanel mailbox of the domain: mail.<domain>, port 465).
 *   2. Otherwise Resend, when RESEND_API_KEY is set (the way it worked before).
 *   3. Otherwise nothing is sent and the caller is told so (false).
 *
 * SMTP settings (Vercel -> Settings -> Environment Variables):
 *   SMTP_HOST    mail.themetroweb.com
 *   SMTP_PORT    465 (default). 587 uses STARTTLS.
 *   SMTP_USER    the full mailbox address, e.g. divieight@themetroweb.com
 *   SMTP_PASS    that mailbox's password. Only ever kept in the environment, never in the code or the repository.
 *   SMTP_FROM    optional sender shown to people, e.g. `divieight <divieight@themetroweb.com>`. Defaults to the mailbox.
 *   SMTP_SECURE  optional: ssl (implicit TLS, the default for 465), starttls (the default for any other port) or none (a local test server only).
 *
 * The client below speaks just what is needed (EHLO, STARTTLS, AUTH PLAIN/LOGIN, MAIL, RCPT, DATA) over Node's own sockets, so no package is added.
 */
import { createHash, randomBytes } from "node:crypto";
import net from "node:net";
import tls from "node:tls";

type Env = Record<string, string | undefined>;

export interface MailMessage {
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
}

export type MailTransport = "smtp" | "resend" | "none";

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  secure: "ssl" | "starttls" | "none";
}

export function smtpConfig(env: Env = process.env): SmtpConfig | null {
  const host = env["SMTP_HOST"]?.trim();
  const user = env["SMTP_USER"]?.trim();
  const pass = env["SMTP_PASS"];
  if (!host || !user || !pass) return null;
  const port = Number(env["SMTP_PORT"] ?? 465) || 465;
  const asked = (env["SMTP_SECURE"] ?? "").trim().toLowerCase();
  const secure = asked === "ssl" || asked === "starttls" || asked === "none" ? asked : port === 465 ? "ssl" : "starttls";
  return { host, port, user, pass, from: env["SMTP_FROM"]?.trim() || `divieight <${user}>`, secure };
}

/** Which way an email would go right now. */
export function mailTransport(env: Env = process.env): MailTransport {
  if (smtpConfig(env)) return "smtp";
  if (env["RESEND_API_KEY"]) return "resend";
  return "none";
}

// ---------------------------------------------------------------------------------------------------------
// The message
// ---------------------------------------------------------------------------------------------------------

const crlf = (s: string) => s.replace(/\r?\n/g, "\r\n");
/** Base64 in 76-character lines, as mail wants it. */
const b64 = (s: string) => (Buffer.from(s, "utf8").toString("base64").match(/.{1,76}/g) ?? [""]).join("\r\n");
/** A header value with any non-ASCII text encoded (RFC 2047). */
const header = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`);
const htmlToText = (html: string) =>
  html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)")
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/** The bare address out of `Name <a@b.c>` or `a@b.c`. */
export const addressOf = (v: string) => (/<([^>]+)>/.exec(v)?.[1] ?? v).trim();

export function buildMime(msg: MailMessage, from: string, domain: string): { raw: string; messageId: string } {
  const to = (Array.isArray(msg.to) ? msg.to : [msg.to]).map((t) => t.trim()).filter(Boolean);
  const messageId = `<${randomBytes(12).toString("hex")}@${domain}>`;
  const base = [
    `From: ${from.replace(/^(.*?)\s*</, (_m, name: string) => (name ? `${header(name.replace(/^"|"$/g, ""))} <` : "<"))}`,
    `To: ${to.join(", ")}`,
    `Subject: ${header(msg.subject.replace(/[\r\n]+/g, " "))}`,
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
  ];
  const text = msg.text ?? (msg.html ? htmlToText(msg.html) : "");
  let body: string[];
  if (msg.html) {
    const boundary = `=_${createHash("sha1").update(messageId).digest("hex").slice(0, 24)}`;
    body = [
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      b64(text),
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      b64(msg.html),
      `--${boundary}--`,
      "",
    ];
  } else {
    body = ['Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", b64(text), ""];
  }
  return { raw: crlf([...base, ...body].join("\n")), messageId };
}

// ---------------------------------------------------------------------------------------------------------
// The SMTP conversation
// ---------------------------------------------------------------------------------------------------------

class SmtpError extends Error {
  constructor(public readonly stage: string, public readonly code: number | null, message: string) {
    super(message);
    this.name = "SmtpError";
  }
}

const TIMEOUT_MS = 20_000;

/** Reads a server's replies one at a time; a reply can run over several lines ("250-..." then "250 ..."). */
class Replies {
  private buffer = "";
  private waiting: { resolve: (r: { code: number; lines: string[] }) => void; reject: (e: Error) => void } | null = null;
  private queued: Array<{ code: number; lines: string[] }> = [];
  private partial: string[] = [];
  private failure: Error | null = null;

  constructor(private socket: net.Socket | tls.TLSSocket) {
    this.attach(socket);
  }

  attach(socket: net.Socket | tls.TLSSocket) {
    this.socket = socket;
    // Decoded here, not with setEncoding: the plain socket is handed to TLS on STARTTLS, and TLS needs the raw bytes.
    socket.on("data", (chunk: string | Buffer) => {
      this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      let i: number;
      while ((i = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, i).replace(/\r$/, "");
        this.buffer = this.buffer.slice(i + 1);
        this.partial.push(line);
        // The last line of a reply has a space after the code ("250 OK"); earlier lines have a dash ("250-SIZE").
        if (/^\d{3} ?/.test(line) && line[3] !== "-") {
          const reply = { code: Number(line.slice(0, 3)), lines: this.partial };
          this.partial = [];
          if (this.waiting) {
            const w = this.waiting;
            this.waiting = null;
            w.resolve(reply);
          } else this.queued.push(reply);
        }
      }
    });
    const fail = (e: Error) => {
      this.failure = e;
      if (this.waiting) {
        const w = this.waiting;
        this.waiting = null;
        w.reject(e);
      }
    };
    socket.on("error", fail);
    socket.on("close", () => fail(new SmtpError("connection", null, "The mail server closed the connection.")));
  }

  /** Stop listening on a socket that is about to be handed to TLS. */
  detach(socket: net.Socket) {
    socket.removeAllListeners("data");
    socket.removeAllListeners("close");
    socket.removeAllListeners("error");
    socket.on("error", () => undefined);
  }

  next(stage: string): Promise<{ code: number; lines: string[] }> {
    const ready = this.queued.shift();
    if (ready) return Promise.resolve(ready);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting = null;
        reject(new SmtpError(stage, null, "The mail server did not answer in time."));
      }, TIMEOUT_MS);
      this.waiting = {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
    });
  }
}

const expect = (r: { code: number; lines: string[] }, stage: string, ok: number[]) => {
  if (!ok.includes(r.code)) throw new SmtpError(stage, r.code, `${stage}: the mail server answered ${r.code}.`);
  return r;
};

function connect(cfg: SmtpConfig): Promise<net.Socket | tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new SmtpError("connect", null, "Could not reach the mail server in time.")), TIMEOUT_MS);
    const done = (s: net.Socket | tls.TLSSocket) => {
      clearTimeout(timer);
      resolve(s);
    };
    const failed = (e: Error) => {
      clearTimeout(timer);
      reject(new SmtpError("connect", null, e.message));
    };
    const socket = cfg.secure === "ssl" ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host }, () => done(socket)) : net.connect({ host: cfg.host, port: cfg.port }, () => done(socket));
    socket.once("error", failed);
  });
}

/** Sends one message. Throws an SmtpError that names the step and the server's code, never the message, the password or the addresses. */
export async function sendViaSmtp(cfg: SmtpConfig, msg: MailMessage): Promise<{ messageId: string }> {
  const recipients = (Array.isArray(msg.to) ? msg.to : [msg.to]).map(addressOf).filter(Boolean);
  if (recipients.length === 0) throw new SmtpError("recipients", null, "No recipient.");
  const domain = addressOf(cfg.from).split("@")[1] ?? cfg.host;
  const { raw, messageId } = buildMime(msg, cfg.from, domain);

  let socket = await connect(cfg);
  const replies = new Replies(socket);
  const say = (line: string) => socket.write(`${line}\r\n`);
  const ehloName = domain;
  try {
    expect(await replies.next("greeting"), "greeting", [220]);
    say(`EHLO ${ehloName}`);
    let ehlo = expect(await replies.next("ehlo"), "ehlo", [250]);

    if (cfg.secure === "starttls") {
      say("STARTTLS");
      expect(await replies.next("starttls"), "starttls", [220]);
      replies.detach(socket as net.Socket);
      const secured = await new Promise<tls.TLSSocket>((resolve, reject) => {
        const t = tls.connect({ socket: socket as net.Socket, servername: cfg.host }, () => resolve(t));
        t.once("error", (e) => reject(new SmtpError("starttls", null, e.message)));
      });
      socket = secured;
      replies.attach(secured);
      say(`EHLO ${ehloName}`);
      ehlo = expect(await replies.next("ehlo"), "ehlo", [250]);
    }

    const offers = ehlo.lines.join(" ").toUpperCase();
    if (offers.includes("AUTH") && /\bPLAIN\b/.test(offers)) {
      say(`AUTH PLAIN ${Buffer.from(`\0${cfg.user}\0${cfg.pass}`, "utf8").toString("base64")}`);
      expect(await replies.next("auth"), "auth", [235]);
    } else {
      say("AUTH LOGIN");
      expect(await replies.next("auth"), "auth", [334]);
      say(Buffer.from(cfg.user, "utf8").toString("base64"));
      expect(await replies.next("auth"), "auth", [334]);
      say(Buffer.from(cfg.pass, "utf8").toString("base64"));
      expect(await replies.next("auth"), "auth", [235]);
    }

    say(`MAIL FROM:<${addressOf(cfg.from)}>`);
    expect(await replies.next("mail from"), "mail from", [250]);
    for (const r of recipients) {
      say(`RCPT TO:<${r}>`);
      expect(await replies.next("rcpt to"), "rcpt to", [250, 251]);
    }
    say("DATA");
    expect(await replies.next("data"), "data", [354]);
    // Dot-stuffing: a line that starts with a dot gets a second one. The body is base64, so this is only a safeguard.
    socket.write(raw.replace(/^\./gm, "..") + "\r\n.\r\n");
    expect(await replies.next("data end"), "data end", [250]);
    // The message is accepted. Say goodbye and give the server a moment to answer before the line is dropped.
    say("QUIT");
    await Promise.race([replies.next("quit").catch(() => undefined), new Promise((r) => setTimeout(r, 1500))]);
    return { messageId };
  } finally {
    socket.end();
    socket.destroy();
  }
}

// ---------------------------------------------------------------------------------------------------------
// The one call the rest of the app makes
// ---------------------------------------------------------------------------------------------------------

/** Sends an email by whichever transport is configured. Returns whether the mail server accepted it. Never throws. */
export async function sendMail(msg: MailMessage, env: Env = process.env): Promise<boolean> {
  const smtp = smtpConfig(env);
  if (smtp) {
    try {
      await sendViaSmtp(smtp, msg);
      return true;
    } catch (e) {
      const err = e as SmtpError;
      // Only the step and the server's code: the reply can echo an address, and the message is the person's own.
      console.error("[mail] SMTP send failed", { stage: err.stage ?? "unknown", code: err.code ?? null });
      return false;
    }
  }
  const key = env["RESEND_API_KEY"];
  if (key) {
    try {
      const { resendFrom } = await import("@/lib/email-sender");
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ from: resendFrom(), to: Array.isArray(msg.to) ? msg.to : [msg.to], subject: msg.subject, ...(msg.html ? { html: msg.html } : {}), ...(msg.text ? { text: msg.text } : {}) }),
      });
      if (!res.ok) console.error("[mail] Resend rejected the send", { status: res.status });
      return res.ok;
    } catch {
      return false;
    }
  }
  return false;
}
