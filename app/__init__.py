from flask import Flask
from flask_socketio import SocketIO
from app.config import Config
import os

# Create SocketIO instance globally so it can be imported by other modules
socketio = SocketIO()

def create_app(config_class=Config):
    app = Flask(__name__)
    app.config.from_object(config_class)
    
    # Ensure upload directories exist
    os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)
    os.makedirs(app.config['OUTPUT_FOLDER'], exist_ok=True)
    
    # Initialize SocketIO with the app
    socketio.init_app(app, cors_allowed_origins="*", async_mode='threading')
    
    # Register blueprints
    from app.routes import dashboard_bp, setup_bp
    app.register_blueprint(dashboard_bp)
    app.register_blueprint(setup_bp, url_prefix='/setup')
    
    return app
