FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

ARG PLATFORM_VERSION=platform-integration-20261028-rc.2
LABEL org.opencontainers.image.version="$PLATFORM_VERSION"

WORKDIR /app

COPY package.json package-lock.json VERSION.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public
COPY docs ./docs
COPY deploy/sql ./deploy/sql
COPY deploy/xhs-batch/schema.sql ./deploy/xhs-batch/schema.sql

RUN grep -Eq '^export const SCREEN_IDLE_TIMEOUT_MS = 10 \* 60 \* 1000;$' /app/public/screen-inactivity-guard.js

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787
ENV DATA_DIR=/app/data

RUN mkdir -p /app/data

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "const http=require('http');const req=http.get({host:'127.0.0.1',port:process.env.PORT||8787,path:'/readyz',timeout:4000},res=>process.exit(res.statusCode===200?0:1));req.on('error',()=>process.exit(1));req.on('timeout',()=>{req.destroy();process.exit(1);});"

CMD ["node", "server/index.mjs"]
