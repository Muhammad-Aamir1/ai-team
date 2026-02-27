# Use an official Node runtime as a parent image (Alpine is lightweight)
FROM node:18-alpine

# Set the working directory in the container
WORKDIR /app

# Copy package.json and package-lock.json first (for caching npm install)
COPY package*.json ./

# Install project dependencies
RUN npm install

# Copy the rest of the backend files to the container
COPY . .

# Expose the port the app runs on (defaults to 5000 in your code)
EXPOSE 5000

# Define the command to run the application
CMD ["node", "server.js"]