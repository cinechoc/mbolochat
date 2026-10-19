#!/bin/bash
command -v node >/dev/null || { curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs; }
npm install -g opencode-ai @qoder-ai/qodercli
git config --global user.name "cinechoc"
git config --global user.email "ton@email.com"
