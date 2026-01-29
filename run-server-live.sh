#!/bin/bash
# Run ASCII Motion MCP Server with live browser sync enabled
cd /Users/cameronfoxly/GitHubRepos/ascii-motion-mcp
exec node dist/index.js --live "$@"
