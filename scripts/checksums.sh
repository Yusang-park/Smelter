#!/usr/bin/env bash
# scripts/checksums.sh
# Generate SHA256 checksums for release binaries

set -euo pipefail

DIST_DIR="${1:-dist/binaries}"
CHECKSUM_FILE="$DIST_DIR/checksums.txt"

# Expected binaries
EXPECTED_BINARIES=(
  "smelter-darwin-arm64"
  "smelter-darwin-x64"
  "smelter-linux-arm64"
  "smelter-linux-x64"
)

echo "Generating checksums for binaries in $DIST_DIR"

cd "$DIST_DIR"

# Verify at least one binary exists
if ! ls smelter-* 1>/dev/null 2>&1; then
  echo "ERROR: No smelter-* binaries found in $DIST_DIR"
  echo "Expected files: ${EXPECTED_BINARIES[*]}"
  exit 1
fi

# Verify all expected binaries exist
missing=()
for binary in "${EXPECTED_BINARIES[@]}"; do
  if [ ! -f "$binary" ]; then
    missing+=("$binary")
  fi
done

if [ ${#missing[@]} -gt 0 ]; then
  echo "ERROR: Missing expected binaries: ${missing[*]}"
  echo "Found binaries:"
  ls -la smelter-* 2>/dev/null || echo "  (none)"
  exit 1
fi

# Generate checksums
shasum -a 256 smelter-* > checksums.txt

echo "Checksums written to $CHECKSUM_FILE:"
cat checksums.txt
