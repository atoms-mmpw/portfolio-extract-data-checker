#!/bin/bash

# Git Setup Script for Docker Container
# This script sets up Git configuration and credentials

echo "🔧 Setting up Git configuration..."

# Set Git user configuration
if [ ! -f ~/.gitconfig ]; then
    echo "📝 Configuring Git user settings..."
    git config --global user.email "${GIT_EMAIL:-you@example.com}"
    git config --global user.name "${GIT_NAME:-Your Name}"
    git config --global credential.helper store
    echo "✅ Git user configuration completed"
else
    echo "ℹ️  Git configuration already exists"
fi

# Set up GitHub Personal Access Token if provided
if [ ! -z "$GIT_TOKEN" ]; then
    echo "🔑 Setting up GitHub Personal Access Token..."
    
    # Create credentials file
    echo "https://${GIT_USERNAME:-$(git config --global user.name)}:${GIT_TOKEN}@github.com" > ~/.git-credentials
    
    # Set up credential helper
    git config --global credential.helper store
    
    echo "✅ GitHub PAT configured"
else
    echo "ℹ️  No GitHub PAT provided (GIT_TOKEN not set)"
    echo "💡 To set up PAT later, run:"
    echo "   echo 'https://username:your-pat@github.com' > ~/.git-credentials"
fi

# Test Git configuration
echo "🧪 Testing Git configuration..."
echo "Git user: $(git config --global user.name)"
echo "Git email: $(git config --global user.email)"

echo "🎉 Git setup completed!"
