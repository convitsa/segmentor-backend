#!/bin/bash

# Start NGINX in background (listens on port 80)
nginx &

# Override Azure's PORT=80 so Bun doesn't conflict with nginx
export PORT=4000

# Start Bun application on port 4000
exec bun run start
