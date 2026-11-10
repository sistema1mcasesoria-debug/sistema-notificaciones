FROM mcr.microsoft.com/playwright:v1.56.1-jammy

WORKDIR /app

# Instalar dependencias del proyecto
COPY package*.json ./
RUN npm install

# Copiar archivos del proyecto
COPY . .

# Compilar TypeScript a JavaScript
RUN npm run build

# Asegurar carpeta de persistencia de datos SQLite
RUN mkdir -p /app/data

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/app/data/sunat.db

CMD ["node", "--import", "tsx", "src/server/webServer.ts"]
