# One image: the web app built and served by the API server.
FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
# The lock file's versions exactly, so the image is the same build as the tested tree.
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /src/package.json /src/package-lock.json ./
COPY --from=build /src/server/package.json server/
RUN npm ci --omit=dev --workspace=server
COPY --from=build /src/server/dist server/dist
COPY --from=build /src/server/admin server/admin
COPY --from=build /src/web/dist web/dist
ENV PORT=8080 DATA_DIR=/data TTS_DIR=/tts CONFIG_DIR=/config
VOLUME ["/config", "/tts"]
EXPOSE 8080
CMD ["node", "server/dist/index.js"]
