#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "=== SNAP SDK Pre-publish Checks ==="
echo ""

cd "${ROOT_DIR}/sdk-package"

echo "Package:"
npm pkg get name version
echo ""

echo "1. Building..."
npm run build
echo ""

echo "2. Running tests..."
npm test
echo ""

echo "3. Package contents:"
npm pack --dry-run
echo ""

echo "=== Ready to publish ==="
echo ""
echo "If this is your first publish, log in first:"
echo "  npm login"
echo ""
echo "Then publish:"
echo "  cd sdk-package && npm publish --access public"
echo ""
echo "For scoped packages, --access public is required for free npm accounts."
