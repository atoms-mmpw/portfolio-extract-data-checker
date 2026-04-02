FROM alpine:3.22

# Install required packages including git
RUN apk update && apk add --no-cache tzdata nodejs npm rsync bash git

# Set timezone
RUN cp /usr/share/zoneinfo/Australia/Sydney /etc/localtime

# Set working directory
WORKDIR /app

# Copy the application files
COPY . .

# Install dependencies
RUN npm install

# Copy and set up Git configuration script
COPY scripts/setup-git.sh /usr/local/bin/setup-git.sh
RUN chmod +x /usr/local/bin/setup-git.sh

# Run Git setup and then the application
CMD ["/bin/bash", "-c", "/usr/local/bin/setup-git.sh && sleep infinity"]
