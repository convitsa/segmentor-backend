# Use an official Node image that supports multi-arch (works on macOS and Linux)
FROM node:22-slim
# Install NGINX, Tini, and other required tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    nginx \
    ca-certificates \
    curl && \
    rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy only package manifests first to take advantage of cached dependency installation
COPY package.json bun.lock ./



# Install pnpm using corepack
# Install bun
RUN npm install --global bun@latest

# Ensure bun is on PATH (usually already is after npm -g)
ENV PATH="/usr/local/bin:${PATH}"

# Install dependencies with bun
RUN bun install


# Copy the rest of the application (including .env)
COPY . .

ARG DATABASE_URL
ARG JWT_SECRET
ARG CORS_ORIGIN
ARG PORT
ARG GOOGLE_CLIENT_ID
ARG GOOGLE_CLIENT_SECRET
ARG STRIPE_SECRET_KEY
ARG STRIPE_WEBHOOK_SECRET
ARG STRIPE_PRICE_ID_MONTHLY
ARG STRIPE_PRICE_ID_YEARLY
ARG RESEND_API_KEY
ARG EMAIL_FROM
ARG POSTHOG_API_KEY

ENV DATABASE_URL=${DATABASE_URL}
ENV JWT_SECRET=${JWT_SECRET}
ENV CORS_ORIGIN=${CORS_ORIGIN}
ENV PORT=${PORT}
ENV GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}
ENV GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET}
ENV STRIPE_SECRET_KEY=${STRIPE_SECRET_KEY}
ENV STRIPE_WEBHOOK_SECRET=${STRIPE_WEBHOOK_SECRET}
ENV STRIPE_PRICE_ID_MONTHLY=${STRIPE_PRICE_ID_MONTHLY}
ENV STRIPE_PRICE_ID_YEARLY=${STRIPE_PRICE_ID_YEARLY}
ENV RESEND_API_KEY=${RESEND_API_KEY}
ENV EMAIL_FROM=${EMAIL_FROM}
ENV POSTHOG_API_KEY=${POSTHOG_API_KEY}

RUN bunx prisma generate
RUN bun run build

# Copy NGINX configuration
RUN mkdir -p /etc/nginx/sites-available \
    && mkdir -p /etc/nginx/sites-enabled \
    && ln -s /etc/nginx/sites-available/app.conf /etc/nginx/sites-enabled/

COPY nginx.conf /etc/nginx/sites-available/app.conf

# Expose required ports
EXPOSE 3000 80 443

# Use a script to start both NGINX and your Node app
COPY start.sh /start.sh
RUN chmod +x /start.sh

# Change CMD to use the script
CMD ["/start.sh"]