# One image per kind of workload, built from the whole workspace:
#
#   docker build --target service -t ballast-service .      # every Node service; pick one with SERVICE=<name>
#   docker build --target console -t ballast-console \
#     --build-arg VITE_API_URL=https://api.example.com .     # the static console behind Caddy
#
# SERVICE is one of: api, price-guard, indexer, keeper, margin-monitor, ledger, issuer-gateway, payout-hop.

FROM node:22-slim AS build
# Node tries IPv4 and IPv6 in turn and gives each attempt 250ms by default; on a network with no IPv6
# route (common in build sandboxes) every attempt times out and downloads fail.
ENV NODE_OPTIONS=--network-family-autoselection-attempt-timeout=5000
RUN corepack enable && corepack prepare pnpm@10.22.0 --activate
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
# No default: a console built without the real API address shows a configuration error instead of
# silently calling localhost.
ARG VITE_API_URL=""
ARG VITE_STELLAR_NETWORK_PASSPHRASE=""
ENV VITE_API_URL=$VITE_API_URL VITE_STELLAR_NETWORK_PASSPHRASE=$VITE_STELLAR_NETWORK_PASSPHRASE
RUN pnpm build

FROM node:22-slim AS service
RUN corepack enable && corepack prepare pnpm@10.22.0 --activate
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app
# Node tries IPv4 and IPv6 in turn and gives each attempt 250ms by default, which times out on
# slow links even though the endpoint is reachable.
ENV NODE_OPTIONS=--network-family-autoselection-attempt-timeout=5000
ARG SERVICE=api
ENV SERVICE=$SERVICE
USER node
CMD ["sh", "-c", "exec pnpm --filter @ballast/service-${SERVICE} start"]

FROM caddy:2-alpine AS console
COPY --from=build /app/apps/console/dist /srv
