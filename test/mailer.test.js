// Tests for the SMTP client, against a minimal fake SMTP server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createMailer } from '../lib/mailer.js';

/** A plain-text SMTP server that records what it receives. */
async function fakeSmtp({ starttls = false, rejectRcpt = false } = {}) {
  const sessions = [];
  const server = net.createServer((socket) => {
    const s = { commands: [], data: '' };
    sessions.push(s);
    let buffer = '';
    let inData = false;
    const reply = (line) => socket.write(`${line}\r\n`);
    reply('220 fake.smtp ESMTP ready');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let i;
      while ((i = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            reply('250 2.0.0 queued');
          } else {
            s.data += `${line}\r\n`;
          }
          continue;
        }
        s.commands.push(line);
        const verb = line.split(' ')[0].toUpperCase();
        if (verb === 'EHLO') reply(`250-fake.smtp\r\n${starttls ? '250-STARTTLS\r\n' : ''}250-AUTH PLAIN LOGIN\r\n250 8BITMIME`);
        else if (verb === 'AUTH') reply(line === `AUTH PLAIN ${Buffer.from('\0mailer\0s3cret').toString('base64')}` ? '235 2.7.0 ok' : '535 5.7.8 bad credentials');
        else if (verb === 'MAIL') reply('250 2.1.0 ok');
        else if (verb === 'RCPT') reply(rejectRcpt ? '550 5.1.1 no such user' : '250 2.1.5 ok');
        else if (verb === 'DATA') { inData = true; reply('354 go ahead'); }
        else if (verb === 'QUIT') { reply('221 bye'); socket.end(); }
        else reply('502 not implemented');
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { sessions, port: server.address().port, close: () => server.close() };
}

test('sends a message with authentication', async () => {
  const smtp = await fakeSmtp();
  try {
    const mailer = createMailer(`smtp://mailer:s3cret@127.0.0.1:${smtp.port}?tls=off`, 'SQLite Admin <noreply@example.com>');
    const text = 'Hello,\n.leading dot line\nConfirm: https://db.example.com/#/verify?token=abc\n';
    await mailer.send({ to: 'ann@example.com', subject: 'Confirm your émail', text });
    const [s] = smtp.sessions;
    assert.ok(s.commands.includes('MAIL FROM:<noreply@example.com>'));
    assert.ok(s.commands.includes('RCPT TO:<ann@example.com>'));
    const [head, body] = s.data.split('\r\n\r\n');
    assert.match(head, /^From: SQLite Admin <noreply@example.com>$/m);
    assert.match(head, /^To: ann@example.com$/m);
    assert.match(head, /^Subject: =\?UTF-8\?B\?/m);
    assert.match(head, /^Content-Transfer-Encoding: base64$/m);
    assert.equal(Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8'), text);
  } finally {
    smtp.close();
  }
});

test('errors name the failed step without revealing the password', async () => {
  const smtp = await fakeSmtp({ rejectRcpt: true });
  try {
    await assert.rejects(
      createMailer(`smtp://mailer:s3cret@127.0.0.1:${smtp.port}?tls=off`, 'noreply@example.com').send({ to: 'x@example.com', subject: 's', text: 't' }),
      (e) => /RCPT TO failed: 550/.test(e.message) && !e.message.includes('s3cret'),
    );
    await assert.rejects(
      createMailer(`smtp://mailer:wrong@127.0.0.1:${smtp.port}?tls=off`, 'noreply@example.com').send({ to: 'x@example.com', subject: 's', text: 't' }),
      (e) => /AUTH failed: 535/.test(e.message) && !e.message.includes('wrong') && !e.message.includes(Buffer.from('\0mailer\0wrong').toString('base64')),
    );
  } finally {
    smtp.close();
  }
});

test('refuses to send in plain text when STARTTLS is not offered', async () => {
  const smtp = await fakeSmtp();
  try {
    await assert.rejects(
      createMailer(`smtp://mailer:s3cret@127.0.0.1:${smtp.port}`, 'noreply@example.com').send({ to: 'x@example.com', subject: 's', text: 't' }),
      /does not offer STARTTLS/,
    );
    assert.ok(!smtp.sessions[0].commands.some((c) => c.startsWith('AUTH')));
  } finally {
    smtp.close();
  }
});

test('rejects bad configuration and header injection', async () => {
  assert.throws(() => createMailer('http://example.com', 'a@example.com'), /smtp:\/\//);
  assert.throws(() => createMailer('smtp://h', ''), /--mail-from/);
  await assert.rejects(createMailer('smtp://h?tls=off', 'a@example.com').send({ to: 'a@example.com\r\nBcc: x@example.com', subject: 's', text: 't' }), /Invalid recipient/);
});
