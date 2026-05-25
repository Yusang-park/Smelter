---
title: Deployment Overview
description: Overview of deployment options for running Smelter locally, with Docker, or on a cloud VPS.
category: deployment
area: infra
audience: [operator]
status: current
sidebar:
  order: 0
---

Smelter can run locally for development or be deployed to a server for always-on operation.

## Deployment Options

| Method | Best For | Guide |
|--------|----------|-------|
| **Local** | Development, personal use | [Local Development](/deployment/local/) |
| **Docker** | Self-hosted servers, CI environments | [Docker](/deployment/docker/) |
| **Cloud VPS** | 24/7 operation with automatic HTTPS | [Cloud Deployment](/deployment/cloud/) |
| **Windows** | Native Windows or WSL2 | [Windows](/deployment/windows/) |

## Database Options

| Option | Setup | Best For |
|--------|-------|----------|
| **SQLite** (default) | Zero config, just omit `DATABASE_URL` | Single-user, CLI usage, local development |
| **Remote PostgreSQL** | Set `DATABASE_URL` to hosted DB | Cloud deployments, shared access |
| **Local PostgreSQL** | Docker `--profile with-db` | Self-hosted, Docker-based setups |

SQLite stores data at `~/.smelter/smelter.db` (or `/.smelter/smelter.db` in Docker). It is auto-initialized on first run.

## Testing

| Guide | Audience |
|-------|----------|
| [E2E Testing](/deployment/e2e-testing/) | Developers and operators |
| [E2E Testing on WSL](/deployment/e2e-testing-wsl/) | Developers on Windows |
