#!/bin/sh
# Deploys ahap_web_editor (Haptic Studio) to /var/www/html/haptic.
# Uses git ls-files so only tracked files get synced, and never passes
# --delete to rsync, matching the deploy pattern used by the other
# denizsincar.ru subdomain projects.

set -e

TARGET="/var/www/html/haptic"
OWNER="denizsincar29"
GROUP="caddy"

cd "$(dirname "$0")"

echo "Deploying to $TARGET ..."
mkdir -p "$TARGET"
git ls-files | rsync -av --files-from=- . "$TARGET/"

echo "Fixing ownership ($OWNER:$GROUP) ..."
chown -R "$OWNER":"$GROUP" "$TARGET"

echo "Done."
