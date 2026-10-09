#!/usr/bin/env bash
# Installs what the integration suite needs in a Debian node image: a virtual display and the
# libraries VS Code's Electron links against, plus the .NET 10 SDK so the C# extension can load
# the shadow file as a file-based app.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  xvfb xauth ca-certificates curl \
  libnss3 libatk1.0-0 libatk-bridge2.0-0 libgtk-3-0 libgbm1 libasound2 libxkbfile1 \
  libsecret-1-0 libxss1 libdrm2 libxshmfence1 libicu72 >/dev/null
if ! command -v dotnet >/dev/null || ! dotnet --list-sdks | grep -q '^10\.'; then
  curl -sSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel 10.0 --install-dir /usr/share/dotnet >/dev/null
  ln -sf /usr/share/dotnet/dotnet /usr/local/bin/dotnet
fi
dotnet --list-sdks
