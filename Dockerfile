# Use a lightweight Python image
FROM python:3.11-slim

# Install system dependencies (Updated with FFmpeg for video support)
RUN apt-get update && apt-get install -y \
    libgl1 \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender-dev \
    ffmpeg \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Set up a new user 'user' (Hugging Face requires a non-root user)
RUN useradd -m -u 1000 user
USER user
ENV HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH

WORKDIR $HOME/app

# Copy requirements first for better caching
COPY --chown=user requirements.txt .

# Install dependencies (using --no-cache-dir to save space)
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the app
COPY --chown=user . .

# Create the uploads folder (Crucial: otherwise uploads fail!)
RUN mkdir -p uploads output && chown -R user:user uploads output

# Hugging Face Spaces always expects port 7860
EXPOSE 7860

# Start command
CMD ["gunicorn", "-k", "eventlet", "-w", "1", "-b", "0.0.0.0:7860", "run:app"]