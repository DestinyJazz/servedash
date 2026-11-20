FROM node:26-alpine
WORKDIR /app
# Install exactly what package-lock.json pins. "npm install" without the
# lockfile resolved fresh versions on every build, so a compromised or
# broken release of any dependency could end up in the image unnoticed.
COPY backend/package.json backend/package-lock.json ./backend/
RUN cd backend && npm ci --omit=dev
COPY backend/ ./backend/
COPY frontend/ ./frontend/
EXPOSE 3000
CMD ["node", "backend/server.js"]
