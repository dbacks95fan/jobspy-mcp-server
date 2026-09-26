# ABOUTME: Builds the MCP server image with Node AND Python + python-jobspy in
# ABOUTME: one container, so a search needs no docker-in-docker at runtime.
# Copyright (c) 2026 DPSystems, LLC. All rights reserved.
FROM node:20-slim

WORKDIR /app

# Python and the JobSpy library live in THIS image. The alternative — spawning a
# separate `jobspy` container per search — needs /var/run/docker.sock mounted
# into a service that is reachable from the internet through the reverse proxy,
# which trades a 200MB layer for a container escape.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

COPY jobspy/requirements.txt /tmp/requirements.txt
RUN pip3 install --no-cache-dir --break-system-packages -r /tmp/requirements.txt

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src/ ./src/
COPY jobspy/ ./jobspy/

# The stash and the search-order log live here; docker-compose mounts a host
# directory over it so both survive a container recreate.
ENV DESCRIPTION_CACHE_DIR=/app/cache/descriptions
RUN mkdir -p /app/cache/descriptions /app/cache/search-order

EXPOSE 9423

# A container that cannot answer /health is a container that never came up, and
# the worst time to discover that is 39 searches into a Friday run.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.JOBSPY_PORT||9423)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
