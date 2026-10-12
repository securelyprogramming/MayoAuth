FROM public.ecr.aws/docker/library/node:24.21.0-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=node:node src ./src
COPY --chown=node:node bin ./bin
COPY --chown=node:node web ./web
RUN mkdir /data && chown node:node /data
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 MAYOAUTH_DATA_DIR=/data
USER node
EXPOSE 8787
CMD ["node", "bin/mayoauth.js", "serve"]
