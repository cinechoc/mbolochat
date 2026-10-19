#!/bin/bash
cd ~/mbolochat
git checkout wip 2>/dev/null || git checkout -b wip
while true; do
  git add -A
  git commit -qm "autosave $(date +%H:%M)" && git push -q origin wip
  sleep 120
done
