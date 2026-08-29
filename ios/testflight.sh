#!/usr/bin/env bash
# Archive, sign for the App Store, and upload to TestFlight.
#
#   ./testflight.sh                      archive + export only
#   ./testflight.sh <KEY_ID> <ISSUER_ID> and upload
#
# The API key is an App Store Connect key (.p8) in ~/.appstoreconnect/private_keys/.
# Create one at App Store Connect → Users and Access → Integrations.
set -euo pipefail
cd "$(dirname "$0")"

KEY_ID="${1:-}"
ISSUER_ID="${2:-}"
ARCHIVE=/tmp/AgentInbox.xcarchive
EXPORT=/tmp/AgentInboxExport

# Every upload needs a build number App Store Connect has not seen before.
BUILD="$(date +%Y%m%d%H%M)"
echo "build number: $BUILD"

xcodebuild -project AgentInbox.xcodeproj -scheme AgentInbox \
  -destination 'generic/platform=iOS' -configuration Release \
  -archivePath "$ARCHIVE" \
  CURRENT_PROJECT_VERSION="$BUILD" \
  archive -allowProvisioningUpdates

rm -rf "$EXPORT"
xcodebuild -exportArchive -archivePath "$ARCHIVE" \
  -exportOptionsPlist ExportOptions.plist \
  -exportPath "$EXPORT" -allowProvisioningUpdates

IPA="$EXPORT/AgentInbox.ipa"
echo "signed: $(codesign -dvvv "$EXPORT/../AgentInboxExport" 2>/dev/null || true)"
echo "built $IPA"

if [ -z "$KEY_ID" ] || [ -z "$ISSUER_ID" ]; then
  cat <<DONE

Not uploading — no API key given.

  ./testflight.sh <KEY_ID> <ISSUER_ID>

Or drag $IPA into Xcode's Organizer (Window → Organizer → Distribute App).
DONE
  exit 0
fi

xcrun altool --upload-app -f "$IPA" -t ios \
  --apiKey "$KEY_ID" --apiIssuer "$ISSUER_ID"

echo "uploaded — it appears in TestFlight once Apple finishes processing."
