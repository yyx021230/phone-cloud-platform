FROM phone-cloud-platform:lookup-throughput-20261022-rc.4
COPY server/index.mjs server/managed-lookup.mjs server/managed-lookup-platform.mjs server/device-occupancy.mjs server/lookup-ai-vision.mjs server/lookup-ai-recovery.mjs /app/server/
RUN node --check /app/server/index.mjs && node --check /app/server/managed-lookup.mjs && node --check /app/server/lookup-ai-vision.mjs && node --check /app/server/lookup-ai-recovery.mjs
