#!/usr/bin/env bash
# pipelines: creates the fork's self-signed macOS code-signing certificate and stores it as the
# GitHub secrets fork-mac-release.yml signs with. Run it once: a new certificate means installed
# apps reject the next update, so after replacing it, install the next release by hand.
set -euo pipefail

repo="${1:-$(git remote get-url origin | sed -E 's#^.*github\.com[:/]##; s#\.git$##')}"
dir="$(mktemp -d)"
trap 'rm -rf "$dir"' EXIT
password="$(openssl rand -hex 24)"

cat >"$dir/cert.cnf" <<'EOF'
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = AgenticWorkflow Self-Signed
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF

openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -config "$dir/cert.cnf" \
  -keyout "$dir/key.pem" -out "$dir/cert.pem" 2>/dev/null
# macOS's keychain cannot read OpenSSL 3's default PKCS#12 encryption.
legacy=()
if openssl version | grep -q '^OpenSSL 3'; then legacy=(-legacy); fi
openssl pkcs12 -export ${legacy[@]+"${legacy[@]}"} -inkey "$dir/key.pem" -in "$dir/cert.pem" \
  -name "AgenticWorkflow Self-Signed" -out "$dir/cert.p12" -passout "pass:$password"

base64 <"$dir/cert.p12" | tr -d '\n' | gh secret set PM_MAC_CERT_P12 --repo "$repo"
printf '%s' "$password" | gh secret set PM_MAC_CERT_PASSWORD --repo "$repo"
echo "Signing certificate stored in $repo. The next push to pm builds a signed release."
