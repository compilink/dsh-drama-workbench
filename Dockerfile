ARG DSH_BUILD_IMAGE=dsh-build:local
ARG NODE_IMAGE=node:24.22.1-alpine
FROM ${DSH_BUILD_IMAGE} AS build
USER root
WORKDIR /build/workbench
COPY package.json compatibility.json ./
COPY scripts/dependencies.mjs scripts/docker-runtime.mjs ./scripts/
RUN --network=none node scripts/docker-runtime.mjs /opt/dsh /runtime/node_modules
COPY tsconfig.json ./
COPY src ./src
RUN --network=none node node_modules/typescript/bin/tsc -p tsconfig.json

FROM ${NODE_IMAGE}
WORKDIR /app
ENV NODE_ENV=production HOME=/tmp
COPY --from=build /runtime/node_modules ./node_modules
COPY --from=build /build/workbench/dist/src ./dist/src
COPY package.json ./
COPY public ./public
COPY --chmod=755 scripts/docker-entrypoint.sh /usr/local/bin/drama-workbench
COPY scripts/model-source-reader.mjs ./scripts/
RUN --network=none mkdir -m 1777 /run/drama-lock /run/drama-models
USER node
RUN --network=none node --input-type=module -e "await import('./dist/src/server.js')"
EXPOSE 4318
ENTRYPOINT ["/usr/local/bin/drama-workbench"]
CMD ["--drama", "--container-listener", "--data-dir", "/data"]
