#!/bin/sh
# Start the Docker daemon
dockerd &
# Wait for Docker to be ready
while ! docker info >/dev/null 2>&1; do sleep 1; done
# Start the Node.js application
exec node app.js