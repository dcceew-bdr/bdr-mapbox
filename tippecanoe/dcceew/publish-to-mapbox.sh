#!/usr/bin/env bash
# Publish nvis_mvg.mbtiles to Mapbox via the Uploads API.
#
# Prompts for the secret token at run time - it is never echoed to the terminal,
# never written to disk, and never stored in shell history.
#
# The token must be a SECRET token (sk....) with scopes:  uploads:write  uploads:read
# NOTE: a token with only tilesets:* scopes returns a misleading 404 on /uploads/v1/,
# not a permissions error. If you get a 404, check the scopes first.
#
# Usage:  bash publish-to-mapbox.sh [/path/to/nvis_mvg.mbtiles]

set -uo pipefail

USERNAME="kevinthiele"
TILESET_ID="nvis_mvg_vector"
TILESET="${USERNAME}.${TILESET_ID}"
DISPLAY_NAME="NVIS MVG (vector)"
MBTILES="${1:-/data/nvis/nvis_mvg.mbtiles}"

if [ ! -f "$MBTILES" ]; then
  echo "ERROR: mbtiles not found: $MBTILES" >&2
  exit 1
fi

command -v aws  >/dev/null || { echo "ERROR: awscli not installed (apt-get install -y awscli)" >&2; exit 1; }
command -v jq   >/dev/null || { echo "ERROR: jq not installed" >&2; exit 1; }
command -v curl >/dev/null || { echo "ERROR: curl not installed" >&2; exit 1; }

echo "File   : $MBTILES ($(du -h "$MBTILES" | cut -f1))"
echo "Target : mapbox://${TILESET}"
echo

# ---- prompt for the secret token (masked, not echoed, not in history) ----
printf 'Mapbox SECRET token (sk...., needs uploads:write + uploads:read): '
read -r -s MAPBOX_TOKEN
echo
if [ -z "$MAPBOX_TOKEN" ]; then echo "No token entered, aborting." >&2; exit 1; fi
case "$MAPBOX_TOKEN" in
  sk.*) ;;
  pk.*) echo "ERROR: that is a PUBLIC token (pk.). Uploads need a SECRET token (sk.)." >&2; exit 1 ;;
  *)    echo "WARNING: token does not start with 'sk.' - continuing anyway." >&2 ;;
esac

api() { curl -sS --fail-with-body "$@"; }

# ---- 1. request temporary S3 staging credentials ----
echo "[1/4] requesting staging credentials..."
CREDS=$(api "https://api.mapbox.com/uploads/v1/${USERNAME}/credentials?access_token=${MAPBOX_TOKEN}" -X POST) || {
  echo "FAILED. A 404 here almost always means the token lacks uploads:* scopes." >&2
  exit 1
}

S3_BUCKET=$(echo "$CREDS" | jq -r .bucket)
S3_KEY=$(echo "$CREDS" | jq -r .key)
export AWS_ACCESS_KEY_ID=$(echo "$CREDS" | jq -r .accessKeyId)
export AWS_SECRET_ACCESS_KEY=$(echo "$CREDS" | jq -r .secretAccessKey)
export AWS_SESSION_TOKEN=$(echo "$CREDS" | jq -r .sessionToken)
export AWS_DEFAULT_REGION=us-east-1

[ "$S3_BUCKET" = "null" ] && { echo "Bad credentials response: $CREDS" >&2; exit 1; }
echo "      staging at s3://${S3_BUCKET}/${S3_KEY}"

# ---- 2. upload the mbtiles to the staging bucket ----
echo "[2/4] uploading mbtiles to staging (this is the slow part)..."
aws s3 cp "$MBTILES" "s3://${S3_BUCKET}/${S3_KEY}" --only-show-errors || {
  echo "S3 upload failed." >&2; exit 1; }
echo "      upload complete"

# ---- 3. kick off the ingest ----
echo "[3/4] creating upload job -> ${TILESET}"
JOB=$(api -X POST "https://api.mapbox.com/uploads/v1/${USERNAME}?access_token=${MAPBOX_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d "{\"url\":\"http://${S3_BUCKET}.s3.amazonaws.com/${S3_KEY}\",\"tileset\":\"${TILESET}\",\"name\":\"${DISPLAY_NAME}\"}") || {
  echo "Failed to create upload job." >&2; exit 1; }

UPLOAD_ID=$(echo "$JOB" | jq -r .id)
echo "      upload id: ${UPLOAD_ID}"

# ---- 4. poll until complete ----
echo "[4/4] waiting for ingest..."
for i in $(seq 1 240); do
  sleep 15
  ST=$(api "https://api.mapbox.com/uploads/v1/${USERNAME}/${UPLOAD_ID}?access_token=${MAPBOX_TOKEN}")
  COMPLETE=$(echo "$ST" | jq -r .complete)
  ERROR=$(echo "$ST" | jq -r .error)
  PROGRESS=$(echo "$ST" | jq -r .progress)

  if [ "$ERROR" != "null" ] && [ -n "$ERROR" ]; then
    echo
    echo "INGEST FAILED: $ERROR" >&2
    echo "(If this mentions tile size, some tile exceeded Mapbox's 500 KB limit -" >&2
    echo " rebuild with more aggressive --drop-densest-as-needed.)" >&2
    exit 1
  fi
  if [ "$COMPLETE" = "true" ]; then
    echo
    echo "=== PUBLISHED ==="
    echo "Tileset : mapbox://${TILESET}"
    echo "Source-layer: mvg    Property: mvg (integer)"
    echo
    echo "Check it at: https://studio.mapbox.com/tilesets/${TILESET}/"
    exit 0
  fi
  printf '\r      progress: %s  (%dm elapsed)' "$PROGRESS" "$((i/4))"
done

echo
echo "Timed out waiting for ingest. Check https://studio.mapbox.com/tilesets/" >&2
exit 1
