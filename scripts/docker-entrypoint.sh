#!/bin/sh
set -eu
umask 077
exec node /app/dist/src/server.js "$@"
