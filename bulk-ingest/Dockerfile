FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates \
    osmium-tool \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY workers/ /app/workers/

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD curl -fsS http://localhost:8080/health || exit 1

# Default to wikidata; override CMD per-deployment for wikipedia / osm-planet.
CMD ["python", "/app/workers/wikidata_dumper.py"]
