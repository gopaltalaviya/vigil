#!/bin/sh
# Copies the Vigil database out of its Docker volume. Safe while services run:
# SQLite's backup takes a consistent snapshot. Usage: deploy/backup.sh [target-dir]
set -eu
target="${1:-./backups}"
mkdir -p "$target"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
docker run --rm -v vigil_vigil-data:/data:ro -v "$(cd "$target" && pwd)":/backup \
  node:24-bookworm-slim node -e "
    const { DatabaseSync, backup } = require('node:sqlite');
    const db = new DatabaseSync('/data/vigil.sqlite', { readOnly: true });
    backup(db, '/backup/vigil-${stamp}.sqlite').then(() => { db.close(); console.log('backup written'); });
  "
echo "$target/vigil-${stamp}.sqlite"
