FROM python:3.12-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1
ENV CONTENT_DIR=/data/content

COPY apps/flask/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY apps/flask ./

EXPOSE 8080
# Ein einzelner Worker mit Threads: der Connector haelt die laufenden Artikel
# in einem prozesslokalen Register, das bei mehreren Workern nicht mehr greift.
CMD ["sh", "-c", "gunicorn --bind 0.0.0.0:${PORT:-8080} --workers 1 --threads 4 --timeout 120 'app:app'"]
