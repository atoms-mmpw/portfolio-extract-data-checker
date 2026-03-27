## Docker

### Clean-up:

```bash
docker ps -a; docker stop portfolio-extract-data-checker; docker rm portfolio-extract-data-checker; docker rmi mmpw/portfolio-extract-data-checker-image
```

### To build the image, from this folder, run:

```bash
docker build --tag mmpw/portfolio-extract-data-checker-image .
```

### To run the image, run:

#### Local Development
```powershell
.\scripts\run-container-local.ps1
```

#### Server Deployment
```powershell
.\scripts\run-container-server.ps1
```

### To start a console of the running container, run:

```bash
docker exec -it portfolio-extract-data-checker /bin/bash
```

### Git Setup

#### Automatic Git Configuration
The container automatically sets up Git configuration on first run using environment variables:

```bash
# Set up Git configuration
docker exec -it portfolio-extract-data-checker /usr/local/bin/setup-git.sh
```

#### Manual Git Configuration
If you need to manually configure Git:

```bash
# Access container
docker exec -it portfolio-extract-data-checker /bin/bash

# Configure Git
git config --global user.email "your-email@example.com"
git config --global user.name "Your Name"

# Set up credential storage for PAT
git config --global credential.helper store
```

#### Setting up Personal Access Token (PAT)
1. **Store credentials in container:**
   ```bash
   docker exec -it portfolio-extract-data-checker /bin/bash
   echo "https://username:your-pat@github.com" > ~/.git-credentials
   ```

2. **Or use environment variables:**
   ```powershell
   docker run -d `
     --mount type=bind,source=c:/Users/AdrianSobotta/Development,target=/mnt/windows-development `
     --hostname portfolio-extract-data-checker `
     --name portfolio-extract-data-checker `
     -e GIT_EMAIL="your-email@example.com" `
     -e GIT_NAME="Your Name" `
     -e GIT_TOKEN="your-personal-access-token" `
     mmpw/portfolio-extract-data-checker-image
   ```

#### Environment Variables for Git

| Variable | Description | Example |
|----------|-------------|---------|
| `GIT_EMAIL` | Your Git email address | `your-email@example.com` |
| `GIT_NAME` | Your Git username | `Your Name` |
| `GIT_USERNAME` | Your GitHub username | `your-github-username` |
| `GIT_TOKEN` | Your GitHub PAT (optional) | `ghp_xxxxxxxxxxxx` |

## 🔑 Git Setup in Container

The container automatically configures Git on startup using the provided environment variables. No manual setup required!

### Automatic Git Configuration
- Git user name and email are set from environment variables
- GitHub Personal Access Token is configured for authentication
- Credential helper is set up to store credentials
- Configuration is persistent within the container

### Manual Git Setup (if needed)
If you need to reconfigure Git manually inside the container:

```bash
# Access the container
docker exec -it portfolio-extract-data-checker /bin/bash

# Run the Git setup script
/usr/local/bin/setup-git.sh

# Or configure manually
git config --global user.email "your-email@example.com"
git config --global user.name "Your Name"
```

### GitHub Personal Access Token Setup
1. Go to [GitHub Settings > Personal Access Tokens](https://github.com/settings/tokens)
2. Generate a new token with these scopes:
   - `repo` (for private repositories)
   - `workflow` (for GitHub Actions)
3. Set the `GIT_TOKEN` environment variable with your token
