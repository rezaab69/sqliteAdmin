// Sends account emails (address confirmation, password reset) over SMTP, without dependencies.
//
//   smtps://user:pass@smtp.example.com:465   TLS from the start
//   smtp://user:pass@smtp.example.com:587    STARTTLS (required)
//   smtp://relay.local:25?tls=off            plain connection, only for a relay on a trusted network
//   log                                      print emails to the console instead (development)
import net from 'node:net';
import tls from 'node:tls';
import os from 'node:os';
import crypto from 'node:crypto';

const TIMEOUT = 30_000;

/** Reads SMTP replies (one or more lines, the last one "NNN text") from a socket. */
function replyReader(socket) {
  let buffer = '';
  let lines = [];
  const replies = [];
  const waiting = [];
  let failure = null;
  const onData = (chunk) => {
    buffer += chunk.toString('utf8');
    let i;
    while ((i = buffer.indexOf('\r\n')) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 2);
      lines.push(line);
      if (!/^\d{3}(?: |$)/.test(line)) continue;
      const reply = { code: Number(line.slice(0, 3)), text: lines.map((l) => l.slice(4)).join('\n') };
      lines = [];
      if (waiting.length) waiting.shift().resolve(reply);
      else replies.push(reply);
    }
  };
  const onEnd = (e) => {
    failure = e instanceof Error ? e : new Error('The SMTP server closed the connection');
    while (waiting.length) waiting.shift().reject(failure);
  };
  socket.on('data', onData);
  socket.on('error', onEnd);
  socket.on('close', onEnd);
  return {
    read() {
      if (replies.length) return Promise.resolve(replies.shift());
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    },
    detach() {
      socket.off('data', onData);
      socket.off('error', onEnd);
      socket.off('close', onEnd);
    },
  };
}

function connect(cfg) {
  return new Promise((resolve, reject) => {
    const servername = net.isIP(cfg.host) ? undefined : cfg.host;
    const socket = cfg.secure
      ? tls.connect({ host: cfg.host, port: cfg.port, servername }, () => resolve(socket))
      : net.connect({ host: cfg.host, port: cfg.port }, () => resolve(socket));
    socket.once('error', reject);
  });
}

function startTls(socket, host) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, servername: net.isIP(host) ? undefined : host }, () => resolve(secure));
    secure.once('error', reject);
  });
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

/** The bare address from "Name <addr@example.com>" or "addr@example.com". */
function address(from) {
  const m = /<([^>]+)>/.exec(from);
  return (m ? m[1] : from).trim();
}

function buildMessage({ from, to, subject, text }) {
  const header = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
  const domain = address(from).split('@')[1] || 'localhost';
  const body = b64(text).replace(/.{76}/g, '$&\r\n');
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${header(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    body,
  ].join('\r\n');
}

async function smtpSend(cfg, { from, to, message }) {
  let socket = await connect(cfg);
  socket.setTimeout(TIMEOUT, () => socket.destroy(new Error('The SMTP server did not respond in time')));
  let reader = replyReader(socket);
  // `label` names the step in errors; the line itself may hold credentials.
  const step = async (line, expect, label) => {
    if (line !== null) socket.write(`${line}\r\n`);
    const reply = await reader.read();
    if (!expect.includes(reply.code)) throw new Error(`SMTP ${label} failed: ${reply.code} ${reply.text}`);
    return reply;
  };
  const hello = `EHLO ${os.hostname().replace(/[^\w.-]/g, '') || 'localhost'}`;
  try {
    await step(null, [220], 'greeting');
    let ehlo = await step(hello, [250], 'EHLO');
    if (!cfg.secure && cfg.starttls) {
      if (!/^STARTTLS\b/im.test(ehlo.text)) {
        throw new Error('The SMTP server does not offer STARTTLS. Use smtps:// or, for a trusted local relay only, add ?tls=off.');
      }
      await step('STARTTLS', [220], 'STARTTLS');
      reader.detach();
      socket = await startTls(socket, cfg.host);
      socket.setTimeout(TIMEOUT, () => socket.destroy(new Error('The SMTP server did not respond in time')));
      reader = replyReader(socket);
      ehlo = await step(hello, [250], 'EHLO');
    }
    if (cfg.user) {
      const auth = /^AUTH[ =](.*)$/im.exec(ehlo.text);
      const mechanisms = auth ? auth[1].toUpperCase().split(/\s+/) : [];
      if (mechanisms.includes('LOGIN') && !mechanisms.includes('PLAIN')) {
        await step('AUTH LOGIN', [334], 'AUTH');
        await step(b64(cfg.user), [334], 'AUTH');
        await step(b64(cfg.pass), [235], 'AUTH');
      } else {
        await step(`AUTH PLAIN ${b64(`\0${cfg.user}\0${cfg.pass}`)}`, [235], 'AUTH');
      }
    }
    await step(`MAIL FROM:<${address(from)}>`, [250], 'MAIL FROM');
    await step(`RCPT TO:<${to}>`, [250, 251], 'RCPT TO');
    await step('DATA', [354], 'DATA');
    await step(`${message.replace(/^\./gm, '..')}\r\n.`, [250], 'sending the message');
    await step('QUIT', [221], 'QUIT').catch(() => {});
  } finally {
    reader.detach();
    socket.destroy();
  }
}

/**
 * @param {string} url Where to send mail (see the top of this file).
 * @param {string} from Sender, e.g. "SQLite Admin <noreply@example.com>".
 * @returns {{ send(m: {to: string, subject: string, text: string}): Promise<void> }}
 */
export function createMailer(url, from) {
  if (url === 'log') {
    return {
      async send({ to, subject, text }) {
        console.log(`\n----- Email to ${to} -----\nSubject: ${subject}\n\n${text}\n--------------------------\n`);
      },
    };
  }
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`Invalid SMTP URL: ${url.replace(/\/\/[^@/]*@/, '//***@')}`);
  }
  if (u.protocol !== 'smtp:' && u.protocol !== 'smtps:') throw new Error('The SMTP URL must start with smtp:// or smtps://');
  if (!from || !address(from).includes('@')) throw new Error('A sender address (--mail-from) is required to send email');
  const cfg = {
    host: u.hostname.replace(/^\[|\]$/g, ''),
    port: Number(u.port) || (u.protocol === 'smtps:' ? 465 : 587),
    secure: u.protocol === 'smtps:',
    starttls: u.searchParams.get('tls') !== 'off',
    user: decodeURIComponent(u.username),
    pass: decodeURIComponent(u.password),
  };
  return {
    async send({ to, subject, text }) {
      if (/[\r\n<>]/.test(to)) throw new Error('Invalid recipient');
      await smtpSend(cfg, { from, to, message: buildMessage({ from, to, subject, text }) });
    },
  };
}
