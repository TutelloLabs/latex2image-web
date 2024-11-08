# Use an official Node.js runtime as a parent image
FROM node:14

# Install Docker
RUN apt-get update && \
    apt-get install -y docker.io && \
    rm -rf /var/lib/apt/lists/*

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

# Run the app
CMD ["node", "app.js"]