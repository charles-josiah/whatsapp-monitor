#!/bin/sh
# Remove stale Chromium profile locks left by previous container
find /app/.wwebjs_auth -name "Singleton*" -delete 2>/dev/null || true
exec node server.js
