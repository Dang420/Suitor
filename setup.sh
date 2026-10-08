#!/usr/bin/env bash
# Suitor one-shot local setup for Arch Linux.
# Run as your normal user (NOT root):  ./setup.sh
set -euo pipefail

if [ "$EUID" -eq 0 ]; then
  echo "Run this as your normal user, not root. It will ask for sudo when needed."
  exit 1
fi

echo "==> Installing system packages (postgresql, nodejs, npm)..."
sudo pacman -S --needed --noconfirm postgresql nodejs npm

echo "==> Initializing PostgreSQL (first run only)..."
if ! sudo -u postgres test -f /var/lib/postgres/data/PG_VERSION; then
  sudo -u postgres initdb -D /var/lib/postgres/data
fi

echo "==> Starting PostgreSQL..."
sudo systemctl enable --now postgresql

echo "==> Creating database role and database..."
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$USER'" | grep -q 1; then
  sudo -u postgres createuser --superuser "$USER"
fi
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='suitor'" | grep -q 1; then
  sudo -u postgres createdb suitor --owner="$USER"
fi

echo "==> Installing Node dependencies..."
npm install

echo "==> Writing .env..."
if [ ! -f .env ]; then
  cp .env.example .env
  JWT=$(openssl rand -hex 32)
  sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$JWT|" .env
  sed -i "s|^DATABASE_URL=.*|DATABASE_URL=postgresql://$USER@/suitor?host=/run/postgresql|" .env
  echo "    generated JWT_SECRET and DATABASE_URL (peer auth, no password needed)"
else
  echo "    .env already exists, leaving it alone"
fi

echo "==> Running migrations..."
npm run migrate

echo ""
echo "All done. Next steps:"
echo "  1. (Optional for now) Add PayPal sandbox credentials to .env:"
echo "       PAYPAL_CLIENT_ID=...   PAYPAL_SECRET=...   (keep PAYPAL_MODE=sandbox)"
echo "     The PayPal SECRET stays in .env on your laptop only - never in chat."
echo "  2. Start the server:  npm start"
echo "  3. Open http://localhost:3000 and create your account."
