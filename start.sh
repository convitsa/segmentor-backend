#!/bin/bash

# Start NGINX in background
nginx &

# Start Bun application
exec bun run start