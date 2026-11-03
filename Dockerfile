# SQLite Admin as a public website. Put it behind an HTTPS reverse proxy; see "Deploying" in README.md.
FROM node:26-slim

WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public

ENV NODE_ENV=production \
    SQLITE_ADMIN_PUBLIC=1 \
    SQLITE_ADMIN_DATA=/data \
    HOST=0.0.0.0 \
    PORT=8765

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8765

HEALTHCHECK --interval=30s --timeout=5s \
  CMD node -e "fetch('http://127.0.0.1:8765/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["node", "server.js"]
