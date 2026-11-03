FROM node:26-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY scripts ./scripts

ENV NODE_ENV=production
ENV DATA_DIR=/data
RUN mkdir /data && chown node:node /data
USER node
