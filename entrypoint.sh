#!/bin/sh
set -e

# Trap SIGTERM and SIGINT
trap 'kill ${!}; exit 0' TERM INT

# Start the Docker daemon
dockerd &
DOCKER_PID=$!

# Wait for Docker to be ready
while ! docker info >/dev/null 2>&1; do 
    sleep 1
done

# Start Node.js application
node app.js &
NODE_PID=$!

# Wait for any process to exit
wait -n

# Exit with status of process that exited first
exit $?