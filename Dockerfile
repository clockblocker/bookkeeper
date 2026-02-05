FROM oven/bun:1-debian

RUN apt-get update && apt-get install -y \
    poppler-utils \
    imagemagick \
    tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src

RUN bun install

ENTRYPOINT ["bun", "run", "src/cli.ts"]
