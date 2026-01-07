# 1. Use an official Node.js image as the base
FROM node:18-slim

# 2. Install Chromium and necessary dependencies for Puppeteer
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# 3. Set environment variables for Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# 4. Create app directory
WORKDIR /usr/src/app

# 5. Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# 6. Copy the rest of the application code
COPY . .

# 7. Create necessary folders
RUN mkdir -p uploads temp_extracted public

# 8. Expose the port Zenith runs on
EXPOSE 3000

# 9. Start the application with optimized memory
CMD ["node", "--max-old-space-size=4096", "app.js"]