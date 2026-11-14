#!/bin/sh
# WS1: confirm whether the ElevenLabs key in .env.local is populated AND live.
# Prints only lengths and HTTP status codes, never secret material.
cd /Users/yorch/hackathon-prd/app || exit 1

val() {
  # $1 = key name; strips optional quotes, ignores comments
  awk -v k="$1" 'index($0,k"=")==1 { v=substr($0,length(k)+2); gsub(/^[ \t]*["'\'']|["'\''][ \t]*$/,"",v); print v; exit }' .env.local
}

KEY=$(val ELEVENLABS_API_KEY)
VID=$(val ELEVENLABS_VOICE_ID)
OID=$(val OPENAI_API_KEY)
AID=$(val ANTHROPIC_API_KEY)

echo "ELEVENLABS_API_KEY length=${#KEY}"
echo "ELEVENLABS_VOICE_ID length=${#VID}"
echo "OPENAI_API_KEY    length=${#OID}"
echo "ANTHROPIC_API_KEY length=${#AID}"

if [ ${#KEY} -eq 0 ]; then
  echo "VERDICT: key unset -> voice telephony must run through the simulator"
  exit 0
fi

CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 \
  -H "xi-api-key: ${KEY}" https://api.elevenlabs.io/v1/voices)
echo "GET /v1/voices -> HTTP ${CODE}"
case "$CODE" in
  200) echo "VERDICT: key LIVE -> real ElevenLabs calls available" ;;
  401|403) echo "VERDICT: key SET BUT INVALID -> dashboard badge will falsely say 'live'" ;;
  000) echo "VERDICT: no network / request failed" ;;
  *) echo "VERDICT: unexpected status ${CODE}" ;;
esac
