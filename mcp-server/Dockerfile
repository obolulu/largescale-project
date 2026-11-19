FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY billing_docs ./billing_docs
COPY data ./data

ENV MCP_TRANSPORT=http MCP_HOST=0.0.0.0 MCP_PORT=8001
EXPOSE 8001
CMD ["python", "-m", "billing_docs.server"]
