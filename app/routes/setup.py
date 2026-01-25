from flask import Blueprint, render_template, request, jsonify, session
from werkzeug.utils import secure_filename
from datetime import datetime
import os
import uuid
from app.services.firebase_service import FirebaseService
from app.services.processing_service import start_processing, get_job_status
from app.config import Config
import cv2
import base64

setup_bp = Blueprint('setup', __name__)

# Initialize services
firebase_service = FirebaseService()

@setup_bp.route('/')
def configuration():
    """Configuration/setup page"""
    return render_template('setup.html')

@setup_bp.route('/upload-video', methods=['POST'])
def upload_video():
    """Handle video upload"""
    if 'video' not in request.files:
        return jsonify({'error': 'No video file'}), 400
    
    file = request.files['video']
    if file.filename == '':
        return jsonify({'error': 'No selected file'}), 400
    
    # Save uploaded file
    filename = secure_filename(file.filename)
    session_id = str(uuid.uuid4())
    upload_path = os.path.join(Config.UPLOAD_FOLDER, f"{session_id}_{filename}")
    file.save(upload_path)
    
    # Store session info
    session['current_session'] = session_id
    session['video_path'] = upload_path
    
    return jsonify({
        'success': True,
        'session_id': session_id,
        'video_path': upload_path
    })

@setup_bp.route('/get-first-frame')
def get_first_frame():
    """Extract and return first frame for line drawing"""
    video_path = session.get('video_path')
    
    if not video_path:
        return jsonify({'error': 'No video uploaded'}), 400
    
    cap = cv2.VideoCapture(video_path)
    ret, frame = cap.read()
    cap.release()
    
    if not ret:
        return jsonify({'error': 'Could not read video'}), 500
    
    frame = cv2.resize(frame, (Config.FRAME_WIDTH, Config.FRAME_HEIGHT))
    
    # Encode frame as base64
    _, buffer = cv2.imencode('.jpg', frame)
    frame_base64 = base64.b64encode(buffer).decode('utf-8')
    
    return jsonify({
        'frame': frame_base64,
        'width': Config.FRAME_WIDTH,
        'height': Config.FRAME_HEIGHT
    })

@setup_bp.route('/save-line', methods=['POST'])
def save_line():
    """Save counting line coordinates"""
    data = request.get_json()
    line_points = data.get('line_points')
    
    if not line_points or len(line_points) != 2:
        return jsonify({'error': 'Invalid line coordinates'}), 400
    
    session['line_points'] = line_points
    
    return jsonify({'success': True})

@setup_bp.route('/start-processing', methods=['POST'])
def start_processing_route():
    """Start video processing in background and return immediately"""
    session_id = session.get('current_session')
    video_path = session.get('video_path')
    line_points = session.get('line_points')
    
    if not all([session_id, video_path, line_points]):
        return jsonify({'error': 'Missing configuration'}), 400
    
    data = request.get_json()
    location = data.get('location', 'Unknown')
    
    # Parse video start time if provided (for historical footage)
    video_start_time = None
    if data.get('video_start_time'):
        try:
            video_start_time = datetime.fromisoformat(data['video_start_time'])
        except ValueError:
            pass
    
    # Store location in session for dashboard display
    session['location'] = location
    
    # Start background processing (returns immediately)
    try:
        job = start_processing(
            session_id=session_id,
            video_path=video_path,
            line_points=line_points,
            location=location,
            video_start_time=video_start_time
        )
        
        return jsonify({
            'success': True,
            'session_id': session_id,
            'status': job.status,
            'message': 'Processing started in background'
        })
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@setup_bp.route('/processing-status/<session_id>')
def processing_status(session_id):
    """Get the status of a processing job"""
    status = get_job_status(session_id)
    
    if status:
        return jsonify(status)
    else:
        return jsonify({'error': 'Job not found'}), 404
