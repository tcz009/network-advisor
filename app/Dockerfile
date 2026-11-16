# Pinned by minor version: :22-alpine floats and made builds unreproducible.
FROM node:22.23-alpine
RUN apk add --no-cache iputils \
    && mkdir -p /data \
    && chown node:node /data
WORKDIR /app
COPY package.json server.js oui.js ./
COPY public ./public
ENV PORT=8090 DATA_DIR=/data BIND_HOST=0.0.0.0
USER node
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD ["node", "-e", "const host = process.env.BIND_HOST === '0.0.0.0' ? '127.0.0.1' : process.env.BIND_HOST; fetch('http://' + host + ':' + process.env.PORT + '/api/pulse').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "server.js"]
