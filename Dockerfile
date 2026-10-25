# Runs Tic-tac-toe in a container: docker compose up, then open http://localhost:8081/play/tictactoe/
# Nothing is installed; the image is Node.js and this folder.
FROM node:22.20.0-alpine3.22
WORKDIR /app
COPY --chown=node:node . .
USER node
# Inside a container the server has to listen on every address for the published port to reach it.
ENV HOST=0.0.0.0 PORT=8081
EXPOSE 8081
HEALTHCHECK --interval=30s --timeout=5s CMD wget -q -O /dev/null http://127.0.0.1:8081/play/tictactoe/ || exit 1
CMD ["node", "serve.mjs"]
