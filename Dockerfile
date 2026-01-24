# Use specific version for stability (matches your package.json engine)
FROM node:18-slim

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
# A wildcard is used to ensure both package.json AND package-lock.json are copied
COPY package*.json ./

# Install production dependencies only (saves space)
RUN npm install --omit=dev

# Copy app source
COPY . .

# Create required directories for volume mapping
RUN mkdir -p uploads temp_extracted public

# Expose the port
EXPOSE 3999

# Start the app with memory limits and garbage collection enabled
CMD ["node", "--expose-gc", "--max-old-space-size=4096", "app.js"]