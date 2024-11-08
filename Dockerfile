FROM docker:dind

# Install Node.js and npm
RUN apk add --update nodejs npm

# Create app directory
WORKDIR /usr/src/app

# Copy application code
COPY . .

# Install app dependencies
RUN npm install

# Expose the port the app runs on
EXPOSE 3000

# Define environment variable
ENV NODE_ENV=production

# Create entrypoint script
COPY <<EOF /usr/local/bin/entrypoint.sh
#!/bin/sh
# Start the Docker daemon
dockerd &
# Wait for Docker to be ready
while ! docker info >/dev/null 2>&1; do sleep 1; done
# Start the Node.js application
exec node app.js
EOF

RUN chmod +x /usr/local/bin/entrypoint.sh

# Use the entrypoint script
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

# Run container with privileged mode:
# docker run --privileged -p 3000:3000 my-node-app