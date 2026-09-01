FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY . .
EXPOSE 3200
CMD ["node", "src/server.js"]
