FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

# Dependencias primero para aprovechar la caché de capas
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY db ./db
COPY scripts ./scripts
COPY src ./src
COPY public ./public

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

# Al arrancar: crea/actualiza las tablas (incluye el admin inicial) y levanta el servidor
CMD ["sh", "-c", "node scripts/init-db.js && exec node src/server.js"]
