FROM node:18-slim
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install
COPY . .
RUN mkdir -p uploads temp_extracted public
EXPOSE 3000
# Use --expose-gc for memory management
CMD ["node", "--expose-gc", "--max-old-space-size=4096", "app.js"]