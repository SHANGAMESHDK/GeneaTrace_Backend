#!/bin/bash
echo "Starting GeneaTrace Backend on Azure App Service..."
python -m uvicorn backend.app.main:app --host 0.0.0.0 --port 8000
