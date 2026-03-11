# Ralph Prompt — nouga-website

## Project
Nouga Mission Control Dashboard — vanilla JS frontend served via Cloudflare + Flask API on localhost:5001.

## Goal
Autonomously implement, fix, and improve dashboard features. Push to production after each working change.

## Rules
- Bump version string in `dashboard/index.html` on every change
- Syntax-check JS: `node --check dashboard/dashboard.js`
- Commit and push when done: `git add dashboard/ && git commit -m "..." && git push`
- Test API: `curl -s http://localhost:5001/api/health`

## Stack
- Frontend: Vanilla JS, no bundler, served as static files
- API: Flask + SocketIO at localhost:5001
- DB: SQLite via database.py
- Deploy: git push → Cloudflare Pages auto-deploys

## Priorities
1. Fix broken UI elements
2. Add missing features from instructions
3. Improve UX and visual polish
