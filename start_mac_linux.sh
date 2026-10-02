#!/usr/bin/env sh
( sleep 1; python3 -m webbrowser http://localhost:3000 >/dev/null 2>&1 || true ) &
node server.js
