FROM node:20-alpine

RUN apk add --no-cache docker-cli

WORKDIR /app

COPY diagnostics ./diagnostics

EXPOSE 9321

CMD ["node", "diagnostics/server.mjs"]
