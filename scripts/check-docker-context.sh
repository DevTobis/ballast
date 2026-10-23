#!/usr/bin/env bash
# Guards against secret leaks in the Docker build context.
# Fails if any .env file (other than *.example templates) enters the Docker build context.
#
#   scripts/check-docker-context.sh   # run by CI

set -euo pipefail
cd "$(dirname "$0")/.."

# Create dummy secret files across root, deploy, and apps to test exclusion
mkdir -p deploy apps/console
touch deploy/.env.prod apps/console/.env .env .env.testnet-deploy

cleanup() {
  rm -f deploy/.env.prod apps/console/.env .env .env.testnet-deploy Dockerfile.test-ctx
}
trap cleanup EXIT

# Throwaway Dockerfile to inspect effective build context
cat << 'EOF' > Dockerfile.test-ctx
FROM busybox
WORKDIR /ctx
COPY . /ctx
EOF

# Build test context image using repo root as context and repo's .dockerignore
docker build -f Dockerfile.test-ctx -t ballast-test-ctx .

# Check that no non-example .env files leaked into /ctx
leaks=$(docker run --rm ballast-test-ctx find /ctx -name '.env*' -not -name '*.example')

# Verify required templates are still present in context
docker run --rm ballast-test-ctx test -f /ctx/.env.example || {
  echo "!!! .env.example missing from Docker context" >&2
  exit 1
}
docker run --rm ballast-test-ctx test -f /ctx/deploy/.env.prod.example || {
  echo "!!! deploy/.env.prod.example missing from Docker context" >&2
  exit 1
}

docker rmi ballast-test-ctx >/dev/null 2>&1 || true

if [[ -n "$leaks" ]]; then
  echo "!!! Secrets or .env files leaked into Docker build context:" >&2
  echo "$leaks" >&2
  exit 1
fi

echo "Docker build context excludes all .env files and preserves example templates"
