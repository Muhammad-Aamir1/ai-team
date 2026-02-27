# --- Stage 1: Build the React application ---
FROM node:18-alpine AS build

# Set the working directory
WORKDIR /app

# Copy dependency files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application
COPY . .

# Build the app for production (Vite outputs to the 'dist' folder)
RUN npm run build

# --- Stage 2: Serve the app using Nginx ---
FROM nginx:alpine

# Copy the built assets from Stage 1 to Nginx's web directory
COPY --from=build /app/dist /usr/share/nginx/html

# (Optional) Copy a custom nginx config if you have routing issues with React Router
# COPY nginx.conf /etc/nginx/conf.d/default.conf

# Expose port 80 to the outside world
EXPOSE 80

# Start Nginx
CMD ["nginx", "-g", "daemon off;"]
