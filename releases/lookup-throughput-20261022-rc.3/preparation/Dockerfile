FROM phone-cloud-platform:lookup-scheduling-20261021-rc.3
LABEL org.opencontainers.image.version="lookup-throughput-20261022-rc.3"
LABEL org.opencontainers.image.revision="9a4362fe2bf3a8e5a48e430519dd23fde135e3fb"
COPY overlay/server/lookup-admin-console.mjs /app/server/lookup-admin-console.mjs
COPY overlay/server/managed-lookup-platform.mjs /app/server/managed-lookup-platform.mjs
COPY overlay/server/device-lock-compatibility.mjs /app/server/device-lock-compatibility.mjs
COPY overlay/server/lookup-human-handover.mjs /app/server/lookup-human-handover.mjs
COPY overlay/server/managed-lookup-store.mjs /app/server/managed-lookup-store.mjs
COPY overlay/server/device-occupancy.mjs /app/server/device-occupancy.mjs
COPY overlay/server/index.mjs /app/server/index.mjs
COPY overlay/server/managed-lookup.mjs /app/server/managed-lookup.mjs
COPY overlay/server/lookup-failure-domain.mjs /app/server/lookup-failure-domain.mjs
COPY overlay/public/index.html /app/public/index.html
COPY overlay/public/lookup-admin.js /app/public/lookup-admin.js
COPY overlay/public/lookup-admin.css /app/public/lookup-admin.css
COPY overlay/public/lookup-admin.html /app/public/lookup-admin.html
COPY overlay/public/app.js /app/public/app.js
COPY overlay/server/lookup-device-availability.mjs /app/server/lookup-device-availability.mjs
COPY overlay/server/lookup-readiness.mjs /app/server/lookup-readiness.mjs
