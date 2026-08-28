#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
work_map_env=''
previous=''

for argument do
  if [ "$previous" = '--work-map-env' ]; then
    work_map_env=$argument
    break
  fi
  previous=$argument
done

if [ -n "$work_map_env" ]; then
  case "$work_map_env" in
    /*) work_map_env_path=$work_map_env ;;
    *) work_map_env_path=$(CDPATH= cd -- "$(dirname -- "$work_map_env")" && pwd)/$(basename -- "$work_map_env") ;;
  esac
  if [ ! -f "$work_map_env_path" ]; then
    echo 'The --work-map-env file does not exist.' >&2
    exit 1
  fi
  exec docker run --rm --network none \
    --user "$(id -u):$(id -g)" \
    --volume "$repo_root:$repo_root" \
    --volume "$work_map_env_path:$work_map_env_path:ro" \
    --workdir "$repo_root" \
    node:22-alpine \
    node "$repo_root/scripts/gateway-admin.mjs" "$@"
fi

exec docker run --rm --network none \
  --user "$(id -u):$(id -g)" \
  --volume "$repo_root:$repo_root" \
  --workdir "$repo_root" \
  node:22-alpine \
  node "$repo_root/scripts/gateway-admin.mjs" "$@"
