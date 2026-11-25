FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY db ./db
USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
