#!/usr/bin/env bash
set -euo pipefail

umask 077

SOURCE_REPO="${SOURCE_REPO:-/opt/routing/toll-booth}"
RUNTIME_DIR="${RUNTIME_DIR:-/opt/sats-for-laughs}"
CONFIG_FILE="${CONFIG_FILE:-$RUNTIME_DIR/deploy.conf}"
CONTAINER_NAME="${CONTAINER_NAME:-sats-for-laughs}"
PHOENIXD_CONTAINER="${PHOENIXD_CONTAINER:-routing-phoenixd-1}"
DEPLOY_REF="${DEPLOY_REF:?DEPLOY_REF must be an exact vMAJOR.MINOR.PATCH release tag}"

if [[ ! "$DEPLOY_REF" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Refusing invalid DEPLOY_REF: $DEPLOY_REF" >&2
  exit 1
fi

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Missing deployment configuration: $CONFIG_FILE" >&2
  exit 1
fi

read_config() {
  local key="$1"
  sed -n "s/^${key}=//p" "$CONFIG_FILE" | tail -n 1
}

PUBLIC_URL="$(read_config PUBLIC_URL)"
ANNOUNCE_RELAYS="$(read_config ANNOUNCE_RELAYS)"

if [[ ! "$PUBLIC_URL" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?(/.*)?$ ]]; then
  echo "PUBLIC_URL must be an HTTPS URL" >&2
  exit 1
fi
if [[ ! "$ANNOUNCE_RELAYS" =~ ^wss://[A-Za-z0-9./,:_-]+$ ]]; then
  echo "ANNOUNCE_RELAYS contains unsupported characters" >&2
  exit 1
fi

git -C "$SOURCE_REPO" fetch --force --tags origin
DEPLOY_COMMIT="$(git -C "$SOURCE_REPO" rev-parse --verify "refs/tags/$DEPLOY_REF^{commit}")"
RELEASE_DIR="$RUNTIME_DIR/releases/$DEPLOY_COMMIT"

install -d -m 700 "$RUNTIME_DIR/releases" "$RUNTIME_DIR/data"
if [[ -d "$RELEASE_DIR" ]]; then
  if [[ "$(git -C "$RELEASE_DIR" rev-parse HEAD)" != "$DEPLOY_COMMIT" ]] ||
     [[ -n "$(git -C "$RELEASE_DIR" status --porcelain)" ]]; then
    echo "Existing release worktree is not the requested clean commit" >&2
    exit 1
  fi
else
  git -C "$SOURCE_REPO" worktree add --detach "$RELEASE_DIR" "$DEPLOY_COMMIT"
fi

PHOENIXD_PASSWORD="$(
  docker exec "$PHOENIXD_CONTAINER" sh -c \
    "sed -n 's/^http-password=//p' /phoenix/.phoenix/phoenix.conf" |
    head -n 1 | tr -d '[:space:]'
)"
if [[ ! "$PHOENIXD_PASSWORD" =~ ^[A-Za-z0-9_-]{32,256}$ ]]; then
  echo "Could not read a valid Phoenixd password; refusing fallback" >&2
  exit 1
fi

ROOT_KEY_FILE="$RUNTIME_DIR/.root-key"
if [[ ! -f "$ROOT_KEY_FILE" ]]; then
  openssl rand -hex 32 >"$ROOT_KEY_FILE"
  chmod 600 "$ROOT_KEY_FILE"
fi
ROOT_KEY="$(tr -d '[:space:]' <"$ROOT_KEY_FILE")"
if [[ ! "$ROOT_KEY" =~ ^[0-9a-f]{64}$ ]]; then
  echo "Invalid persisted macaroon root key" >&2
  exit 1
fi

IMAGE_TAG="sats-for-laughs:${DEPLOY_COMMIT}"
docker build \
  --label "org.opencontainers.image.revision=$DEPLOY_COMMIT" \
  --label "org.opencontainers.image.version=$DEPLOY_REF" \
  -f "$RELEASE_DIR/examples/sats-for-laughs/Dockerfile" \
  -t "$IMAGE_TAG" \
  "$RELEASE_DIR"

ENV_FILE="$(mktemp "$RUNTIME_DIR/runtime.env.XXXXXX")"
trap 'rm -f "$ENV_FILE"' EXIT
{
  printf 'MOCK=false\n'
  printf 'PHOENIXD_URL=http://localhost:9740\n'
  printf 'PHOENIXD_PASSWORD=%s\n' "$PHOENIXD_PASSWORD"
  printf 'ROOT_KEY=%s\n' "$ROOT_KEY"
  printf 'PORT=3001\n'
  printf 'DATA_DIR=/data\n'
  printf 'PUBLIC_URL=%s\n' "$PUBLIC_URL"
  printf 'ANNOUNCE_RELAYS=%s\n' "$ANNOUNCE_RELAYS"
} >"$ENV_FILE"
chmod 600 "$ENV_FILE"

ROLLBACK_NAME="${CONTAINER_NAME}-rollback"
if docker container inspect "$ROLLBACK_NAME" >/dev/null 2>&1; then
  echo "Stale rollback container exists: $ROLLBACK_NAME" >&2
  exit 1
fi

HAD_PREVIOUS=0
if docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
  HAD_PREVIOUS=1
  docker stop "$CONTAINER_NAME"
  docker rename "$CONTAINER_NAME" "$ROLLBACK_NAME"
fi

rollback() {
  docker stop "$CONTAINER_NAME" >/dev/null 2>&1 || true
  docker rm "$CONTAINER_NAME" >/dev/null 2>&1 || true
  if [[ "$HAD_PREVIOUS" == "1" ]]; then
    docker rename "$ROLLBACK_NAME" "$CONTAINER_NAME"
    docker start "$CONTAINER_NAME"
  fi
}

if ! docker run -d \
  --name "$CONTAINER_NAME" \
  --network host \
  --restart always \
  --volume "$RUNTIME_DIR/data:/data" \
  --env-file "$ENV_FILE" \
  "$IMAGE_TAG"; then
  rollback
  exit 1
fi

healthy=0
for _ in $(seq 1 20); do
  if curl --fail --silent --show-error http://127.0.0.1:3001/ >/dev/null; then
    healthy=1
    break
  fi
  sleep 2
done

if [[ "$healthy" != "1" ]]; then
  docker logs --tail 50 "$CONTAINER_NAME" >&2 || true
  rollback
  exit 1
fi

if [[ "$HAD_PREVIOUS" == "1" ]]; then
  docker rm "$ROLLBACK_NAME"
fi
printf '%s\n' "$DEPLOY_COMMIT" >"$RUNTIME_DIR/deployed-commit"
printf '%s\n' "$DEPLOY_REF" >"$RUNTIME_DIR/deployed-version"
chmod 644 "$RUNTIME_DIR/deployed-commit" "$RUNTIME_DIR/deployed-version"
echo "Deployed $DEPLOY_REF at $DEPLOY_COMMIT"
