# Pinned by minor version: :22-alpine floats and made builds unreproducible.
FROM node:22.23-alpine
RUN apk add --no-cache iputils tcpdump \
    && mkdir -p /data \
    && chown node:node /data
WORKDIR /app
# Glob rather than a list: adding app/kasa.js once shipped an image without it
# and the container crash-looped. The require check below then fails the build
# instead of the deployment.
COPY package.json *.js ./
COPY public ./public
RUN node -e "require('./server.js'); console.log('modules load')"
ENV PORT=8090 DATA_DIR=/data BIND_HOST=0.0.0.0
USER node
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD ["node", "-e", "const host = process.env.BIND_HOST === '0.0.0.0' ? '127.0.0.1' : process.env.BIND_HOST; fetch('http://' + host + ':' + process.env.PORT + '/api/pulse').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "server.js"]
