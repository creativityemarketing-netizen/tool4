# VoxText Studio — Node server that also shells out to yt-dlp + ffmpeg
FROM node:20-slim

# yt-dlp (video/audio download) + ffmpeg (audio extraction) + python3 (yt-dlp runtime)
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 ffmpeg ca-certificates curl \
  && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
  && chmod a+rx /usr/local/bin/yt-dlp \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install only production deps first (better build caching)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy the rest of the app
COPY . .

# Render provides PORT at runtime; server.js already reads process.env.PORT
EXPOSE 4174
CMD ["node", "server.js"]
