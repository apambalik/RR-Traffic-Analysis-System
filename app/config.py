import os
from dotenv import load_dotenv

load_dotenv()

class Config:
    SECRET_KEY = os.environ.get('SECRET_KEY') or 'dev-secret-key'
    UPLOAD_FOLDER = os.environ.get('UPLOAD_FOLDER', 'uploads')
    OUTPUT_FOLDER = os.environ.get('OUTPUT_FOLDER', 'output')
    MAX_CONTENT_LENGTH = int(os.environ.get('MAX_CONTENT_LENGTH', 524288000))
    
    # Firebase
    FIREBASE_CREDENTIALS = os.environ.get('FIREBASE_CREDENTIALS_PATH')
    FIREBASE_DATABASE_URL = os.environ.get('FIREBASE_DATABASE_URL')
    
    # Model
    MODEL_PATH = os.environ.get('MODEL_PATH', 'model_data/checkpoint_best_total.pth')
    CONFIDENCE_THRESHOLD = 0.5
    FRAME_WIDTH = 672
    FRAME_HEIGHT = 448
    
    # Vehicle capacity mapping
    VEHICLE_CAPACITY = {
        'Sedan': {'min': 1, 'max': 5},
        'SUV': {'min': 1, 'max': 8},
        'Pickup': {'min': 1, 'max': 6},
        'Van': {'min': 1, 'max': 15},
        'Motorcycle': {'min': 1, 'max': 2},
        'Bus': {'min': 1, 'max': 50},
        'Truck': {'min': 1, 'max': 3}
    }
    
    # Live Stream Settings
    LIVE_STREAM_RETRY_ATTEMPTS = 5
    LIVE_STREAM_RETRY_DELAY = 2  # seconds between reconnection attempts
    LIVE_STREAM_CONNECTION_TIMEOUT = 10  # seconds to wait for initial connection
    LIVE_STREAM_BUFFER_SIZE = 1  # minimize latency by keeping buffer small
    
    # Firebase Update Intervals (seconds) - for efficiency
    FIREBASE_EVENT_BATCH_INTERVAL = 30  # Batch events every 30 seconds
    FIREBASE_STATISTICS_INTERVAL = 45  # Update statistics every 45 seconds
    FIREBASE_LIVE_STREAM_INTERVAL = 30  # Live stream data save interval