#!/usr/bin/env bash
# Build docs + marketing site and push to gh-pages branch.
# GitHub Pages then serves it (Source: Deploy from branch → gh-pages /(root)).
# Custom domain: ive.dev
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE="${PAGES_REMOTE:-origin}"
DOMAIN="${PAGES_DOMAIN:-ive.dev}"

echo "==> Building VitePress docs"
cd "$REPO_ROOT/docs"
[ -d node_modules ] || npm install
npm run docs:build

echo "==> Assembling _site"
SITE_DIR="$(mktemp -d)"
trap 'rm -rf "$SITE_DIR"' EXIT
cp "$REPO_ROOT/marketing_material/website/index.html" "$SITE_DIR/"
cp "$REPO_ROOT/marketing_material/website/ive-promo.mp4" "$SITE_DIR/"
cp -r "$REPO_ROOT/docs/.vitepress/dist" "$SITE_DIR/docs"
echo "$DOMAIN" > "$SITE_DIR/CNAME"
touch "$SITE_DIR/.nojekyll"

echo "==> Pushing to $REMOTE/gh-pages"
cd "$SITE_DIR"
git init -b gh-pages -q
git add -A
git -c user.email="$(cd "$REPO_ROOT" && git config user.email)" \
    -c user.name="$(cd "$REPO_ROOT" && git config user.name)" \
    commit -q -m "Deploy $(date -u +%Y-%m-%dT%H:%M:%SZ)"
REMOTE_URL="$(cd "$REPO_ROOT" && git remote get-url "$REMOTE")"
git remote add origin "$REMOTE_URL"
git -c http.version=HTTP/1.1 -c http.postBuffer=524288000 \
    push -u origin gh-pages -f

echo
echo "==> Deployed."
echo "   Marketing: https://$DOMAIN/"
echo "   Docs:      https://$DOMAIN/docs/"
