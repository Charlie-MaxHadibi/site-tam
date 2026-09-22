# --- Étape build : compile les dépendances natives (better-sqlite3) ---
FROM node:22-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# --- Étape runtime : image finale, sans les outils de compilation ---
FROM node:22-slim

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY . .

RUN mkdir -p data

EXPOSE 3000
CMD ["npm", "start"]
