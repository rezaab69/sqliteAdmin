# Ubuntu Website Setup Guide

Nov 4, 2026 · @hi claude

## Overview

The script is SQLite Admin, a web panel for SQLite databases similar to phpMyAdmin. In public mode, visitors upload, edit and download databases in private workspaces, and they can create accounts.

The project has no npm dependencies. It needs Node.js 26 and uses the built-in `node:sqlite` module.

The finished setup works like this:

- Browser connects to Caddy on port 443 over HTTPS.
- Caddy gets the certificate and forwards requests to the app on `127.0.0.1:8765`.
- The app runs as a `systemd` service and keeps its data in `/var/lib/sqlite-admin`.

## Prerequisites

- An Ubuntu 24.04 LTS server (or newer) with `sudo` access and a public IP address.
- A domain name, such as `db.example.com`, and access to its DNS settings.
- Ports 80 and 443 open to the internet. Caddy needs them to get the HTTPS certificate.
- The project folder `D:\ClaudeCode\sqlite` on the Windows PC, to copy files from.
- Optional: an SMTP account for sign-up emails, and a Google OAuth client for "Continue with Google".

The Caddy and NodeSource commands below come from their install guides, not re-checked for this document. If one fails, check the current steps at caddyserver.com/docs/install and github.com/nodesource/distributions.

## Setup steps

Run these commands on the Ubuntu server unless a step says otherwise.

### 1. Install Node.js 26

```bash
curl -fsSL https://deb.nodesource.com/setup_26.x | sudo -E bash -
sudo apt install -y nodejs
node --version
```

The last line should print a version that starts with `v26`.

### 2. Create a service user and folders

```bash
sudo useradd --system --home /var/lib/sqlite-admin --shell /usr/sbin/nologin sqlite-admin
sudo mkdir -p /opt/sqlite-admin /var/lib/sqlite-admin
sudo chown sqlite-admin:sqlite-admin /var/lib/sqlite-admin
```

### 3. Copy the project files to the server

On the server, create a staging folder:

```bash
mkdir -p ~/sqlite-admin
```

On the Windows PC, open PowerShell and copy the app files. Replace `you` and `server-ip`. Do not copy the `data\` folder (it holds local test databases) or `graphify-out\`.

```powershell
scp -r D:\ClaudeCode\sqlite\package.json D:\ClaudeCode\sqlite\server.js D:\ClaudeCode\sqlite\lib D:\ClaudeCode\sqlite\public D:\ClaudeCode\sqlite\Dockerfile you@server-ip:sqlite-admin/
```

Back on the server, move the files into place:

```bash
sudo cp -r ~/sqlite-admin/. /opt/sqlite-admin/
ls /opt/sqlite-admin    # should list: Dockerfile lib package.json public server.js
```

### 4. Write the settings file

```bash
sudo nano /etc/sqlite-admin.env
```

Paste this, changing the domain and the mail lines to your own values:

```ini
SQLITE_ADMIN_PUBLIC=1
SQLITE_ADMIN_TRUST_PROXY=1
SQLITE_ADMIN_PUBLIC_URL=https://db.example.com
HOST=127.0.0.1
PORT=8765
SQLITE_ADMIN_DATA=/var/lib/sqlite-admin
SQLITE_ADMIN_SMTP_URL=smtps://USER:PASSWORD@smtp.example.com:465
SQLITE_ADMIN_MAIL_FROM="SQLite Admin <noreply@example.com>"
```

Lock the file down, because it holds passwords:

```bash
sudo chmod 600 /etc/sqlite-admin.env
```

- Delete the `SQLITE_ADMIN_SMTP_URL` and `SQLITE_ADMIN_MAIL_FROM` lines if you do not need email sign-up. Guests can still use the site.
- URL-encode special characters in the SMTP password. For example, `@` becomes `%40`.

### 5. Create the systemd service

```bash
sudo nano /etc/systemd/system/sqlite-admin.service
```

```ini
[Unit]
Description=SQLite Admin public website
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=sqlite-admin
Group=sqlite-admin
WorkingDirectory=/opt/sqlite-admin
EnvironmentFile=/etc/sqlite-admin.env
ExecStart=/usr/bin/node /opt/sqlite-admin/server.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
```

Run `which node`. If it prints a path other than `/usr/bin/node`, use that path in `ExecStart`. Then start the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now sqlite-admin
```

### 6. Install Caddy for HTTPS

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
```

Replace the contents of `/etc/caddy/Caddyfile` with:

```
db.example.com {
    reverse_proxy 127.0.0.1:8765 {
        header_up Host {upstream_hostport}
    }
}
```

The `header_up Host` line is required. When the app listens on `127.0.0.1`, it accepts only the Host names `localhost`, `127.0.0.1` and `::1`. Without this line, Caddy forwards `db.example.com`, and visitors see `Forbidden: unexpected Host header`. Keep the app on `127.0.0.1`.

Apply it. Caddy requests the certificate automatically the first time the site is visited:

```bash
sudo systemctl reload caddy
```

### 7. Point the domain and open the firewall

1. In your DNS provider, add an `A` record for `db` (or `@`) that points to the server's public IP. Wait until the record resolves, for example with dnschecker.org.
2. Allow SSH, HTTP and HTTPS, then enable the firewall. Answer `y` to the prompt:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

Port 8765 stays closed to the internet. Only Caddy reaches it.

### 8. Optional: enable Google sign-in

1. In the Google Cloud console, go to *APIs & Services > Credentials* and create an *OAuth client ID* of type *Web application*.
2. Add `https://db.example.com/auth/google/callback` as an authorized redirect URI.
3. Set up the OAuth consent screen with the `openid`, `email` and `profile` scopes.
4. Add these lines to `/etc/sqlite-admin.env`:

```ini
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
```

5. Restart the service with `sudo systemctl restart sqlite-admin`.

### Alternative: Docker instead of steps 2 and 5

The project's `Dockerfile` runs public mode as a non-root user and keeps data in a Docker volume.

```bash
sudo apt install -y docker.io
cd ~/sqlite-admin
sudo docker build -t sqlite-admin .
sudo docker run -d --name sqlite-admin --restart unless-stopped -p 127.0.0.1:8765:8765 -v sqlite-admin-data:/data --env-file /etc/sqlite-admin.env sqlite-admin
```

Before running it, make the env file suitable for Docker. Remove the `HOST`, `PORT` and `SQLITE_ADMIN_DATA` lines, because the image sets them. Also remove the quotes around the mail sender, because `--env-file` keeps them as part of the value. Keep step 6 and step 7 as they are.

## Verify and run

1. Check that the service is running. Look for `active (running)`:

```bash
sudo systemctl status sqlite-admin --no-pager
```

2. Read the startup log. It should show `running at http://127.0.0.1:8765/` and a `Public mode:` line. If it asks you to serve over HTTPS, `SQLITE_ADMIN_TRUST_PROXY=1` is missing.

```bash
sudo journalctl -u sqlite-admin -n 50 --no-pager
```

3. Check the app on the server. This should return an HTTP 2xx status:

```bash
curl -i http://127.0.0.1:8765/healthz
```

4. Check HTTPS from outside the server. This should return a 2xx status with no certificate error:

```bash
curl -sI https://db.example.com
```

5. Open `https://db.example.com` in a browser. You should get a guest workspace that starts with a copy of the sample database.

### Routine tasks

- **Update the app:** copy the new files as in step 3, then run `sudo systemctl restart sqlite-admin`.
- **Read logs live:** `sudo journalctl -u sqlite-admin -f`.
- **Back up:** copy `/var/lib/sqlite-admin/app.db` and the `/var/lib/sqlite-admin/users/` folder. Stop the service first (`sudo systemctl stop sqlite-admin`) for a consistent copy, then start it again. The `workspaces/` and `tmp/` folders can be skipped.
- **Stop or start:** `sudo systemctl stop sqlite-admin` or `sudo systemctl start sqlite-admin`.

## Troubleshooting

For any problem, start with `sudo journalctl -u sqlite-admin -n 50 --no-pager`. Caddy logs are in `sudo journalctl -u caddy -n 50 --no-pager`.

| Problem | Fix |
| --- | --- |
| Log says Node.js is too old for `setAuthorizer` | Node is older than 26. Run `node --version`, then reinstall Node 26 from step 1. If `setup_26.x` is not found, install Node 26 from nodejs.org and set `ExecStart` to the path from `which node`. |
| Log says `--public-url` is not valid, or must start with `https://` | Fix the `SQLITE_ADMIN_PUBLIC_URL` line in `/etc/sqlite-admin.env`. |
| Log says `--password is for single-user mode` | Delete the `SQLITE_ADMIN_PASSWORD` line from the env file. |
| Log says Google sign-in needs the client secret | Add `GOOGLE_CLIENT_SECRET` to the env file. |
| Log says port 8765 is already in use | Run `sudo ss -ltnp` and find the other process. Stop it, or change `PORT` and the Caddyfile. |
| `EACCES` or permission denied in the log | Run `sudo chown -R sqlite-admin:sqlite-admin /var/lib/sqlite-admin`, then restart the service. |
| Browser shows 502 Bad Gateway | The app is not running. Check `sudo systemctl status sqlite-admin` and the log. |
| Browser cannot reach the site at all | The DNS record is not live yet, or ports 80 and 443 are closed. Check `sudo ufw status`. |
| Caddy log shows certificate errors | The domain must point to this server before Caddy can get a certificate. Check the DNS record and ports 80 and 443. |
| Changed the env file, but nothing changed | Settings are read at start. Run `sudo systemctl restart sqlite-admin`. |
| New visitors see "server busy" | All worker slots are in use. Add `--max-workers 32` to `ExecStart` in the service file, then run `sudo systemctl daemon-reload` and restart. Each worker can use about 55 MB, up to 512 MB while working, so check the server has enough RAM. |
| Sign-up emails do not arrive | Check the SMTP host, port and password. The sender domain must be allowed by your mail provider. Look for mailer errors in the log. |
| Google shows `redirect_uri_mismatch` | The redirect URI in Google Cloud must match `https://db.example.com/auth/google/callback` exactly, including `https://`. |

### Forbidden: unexpected Host header

This message means Caddy forwarded the domain name to the app. Add the `header_up Host {upstream_hostport}` block from step 6 to the Caddyfile, then run `sudo systemctl reload caddy`.

### Sources

- Project files read for this guide: `README.md`, `server.js`, `package.json` and `Dockerfile` in `D:\ClaudeCode\sqlite`. Read on 2026-11-04.
- Caddy and NodeSource install commands: from their official install guides. Not re-checked for this document. See [Caddy install](https://caddyserver.com/docs/install) and [NodeSource distributions](https://github.com/nodesource/distributions).
