# Track the Node.js 24 LTS line rather than an exact release: every image build pulls the
# latest 24.x security patch (24.22.1 or newer). Rebuild the image to pick up new releases.
FROM node:24-trixie-slim

# Install additional terminal utilities and prerequisites
RUN apt-get update && apt-get upgrade -y && apt-get install -y --fix-missing \
    apt-utils \
    curl \
    wget \
    ssh \
    git \
    vim \
    nano \
    htop \
    net-tools \
    iputils-ping \
    fontconfig \
    unzip \
    locales \
    traceroute \
    build-essential \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# Configure locales
RUN sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen && \
    locale-gen en_US.UTF-8 && \
    update-locale LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8

# Set environment variables for locale
ENV LANG=en_US.UTF-8 \
    LANGUAGE=en_US:en \
    LC_ALL=en_US.UTF-8 \
    SHELL=/bin/bash

# Install Starship
RUN curl -sS https://starship.rs/install.sh | sh -s -- --yes
WORKDIR /app

# Copy package files first for better layer caching
COPY package*.json ./

# Install dependencies
RUN npm ci --omit=dev && \
    npm cache clean --force

# Copy entrypoint script and set permissions
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Create data directory
RUN mkdir -p data

# Copy application files
COPY . .

# Build node-pty and copy xterm files
RUN npm run copy-xterm

# Expose port
EXPOSE 3000

# Start the application
ENTRYPOINT ["/entrypoint.sh"]
CMD ["npm", "start"]