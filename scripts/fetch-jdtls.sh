#!/usr/bin/env bash
# Fetch the Eclipse JDT Language Server distribution into vendor/jdtls.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/vendor/jdtls"
URL="${JDTLS_URL:-https://download.eclipse.org/jdtls/snapshots/jdt-language-server-latest.tar.gz}"

if [ -f "$DEST/plugins/org.eclipse.equinox.launcher.jar" ] || ls "$DEST"/plugins/org.eclipse.equinox.launcher_*.jar >/dev/null 2>&1; then
  echo "jdtls already present at $DEST"
  exit 0
fi

mkdir -p "$DEST"
echo "downloading jdtls from $URL"
curl -fsSL "$URL" -o /tmp/jdtls.tar.gz
tar -xzf /tmp/jdtls.tar.gz -C "$DEST"
rm -f /tmp/jdtls.tar.gz

ls "$DEST"/plugins/org.eclipse.equinox.launcher_*.jar >/dev/null
echo "jdtls installed at $DEST"
