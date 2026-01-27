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
    try:
        print(f"Upload request received. Files: {request.files.keys()}, Form: {request.form.keys()}")
        
        if 'video' not in request.files:
            print("Error: No video file in request")
            return jsonify({'error': 'No video file'}), 400
        
        file = request.files['video']
        if file.filename == '':
            print("Error: Empty filename")
            return jsonify({'error': 'No selected file'}), 400
        
        # Get camera role from form data
        camera_role = request.form.get('camera_role', 'ENTRY')
        print(f"Uploading video for camera: {camera_role}")
        
        # Save uploaded file
        filename = secure_filename(file.filename)
        session_id = session.get('current_session')
        if not session_id:
            session_id = str(uuid.uuid4())
            session['current_session'] = session_id
            print(f"Created new session: {session_id}")
        
        upload_path = os.path.join(Config.UPLOAD_FOLDER, f"{session_id}_{camera_role}_{filename}")
        print(f"Saving to: {upload_path}")
        
        file.save(upload_path)
        print(f"File saved successfully. Size: {os.path.getsize(upload_path)} bytes")
        
        # Initialize camera storage structure if needed
        if 'cameras' not in session:
            session['cameras'] = {'ENTRY': {}, 'EXIT': {}}
        
        # Store video path for specific camera
        session['cameras'][camera_role]['video_path'] = upload_path
        session['cameras'][camera_role]['has_video'] = True
        session.modified = True
        
        print(f"Upload successful for {camera_role} camera")
        return jsonify({
            'success': True,
            'session_id': session_id,
            'camera_role': camera_role,
            'video_path': upload_path
        })
        
    except Exception as e:
        print(f"Upload error: {str(e)}")
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500

@setup_bp.route('/get-first-frame')
def get_first_frame():
    """Extract and return first frame for line drawing"""
    camera_role = request.args.get('camera_role', 'ENTRY')
    
    # Get camera-specific video path
    cameras = session.get('cameras', {})
    camera_data = cameras.get(camera_role, {})
    video_path = camera_data.get('video_path')
    
    if not video_path:
        return jsonify({'error': 'No video uploaded for this camera'}), 400
    
    cap = cv2.VideoCapture(video_path)
    ret, frame = cap.read()
    cap.release()
    
    if not ret:
        return jsonify({'error': 'Could not read video'}), 500
    
    frame = cv2.resize(frame, (Config.FRAME_WIDTH, Config.FRAME_HEIGHT))
    
    # Encode frame as base64
    _, buffer = cv2.imencode('.jpg', frame)
    frame_base64 = base64.b64encode(buffer).decode('utf-8')
    
    # Get line points if they exist for this camera
    line_points = camera_data.get('line_points')
    
    return jsonify({
        'frame': frame_base64,
        'width': Config.FRAME_WIDTH,
        'height': Config.FRAME_HEIGHT,
        'line_points': line_points
    })

@setup_bp.route('/save-line', methods=['POST'])
def save_line():
    """Save counting line coordinates"""
    data = request.get_json()
    line_points = data.get('line_points')
    camera_role = data.get('camera_role', 'ENTRY')
    
    if not line_points or len(line_points) != 2:
        return jsonify({'error': 'Invalid line coordinates'}), 400
    
    # Initialize camera storage if needed
    if 'cameras' not in session:
        session['cameras'] = {'ENTRY': {}, 'EXIT': {}}
    
    # Store line points for specific camera
    session['cameras'][camera_role]['line_points'] = line_points
    session['cameras'][camera_role]['has_line'] = True
    session.modified = True
    
    return jsonify({'success': True, 'camera_role': camera_role})

@setup_bp.route('/start-processing', methods=['POST'])
def start_processing_route():
    """Start video processing in background and return immediately"""
    session_id = session.get('current_session')
    data = request.get_json()
    camera_role = data.get('camera_role', 'ENTRY')
    
    # Get camera-specific configuration
    cameras = session.get('cameras', {})
    camera_data = cameras.get(camera_role, {})
    video_path = camera_data.get('video_path')
    line_points = camera_data.get('line_points')
    
    if not all([session_id, video_path, line_points]):
        return jsonify({'error': f'Missing configuration for {camera_role} camera'}), 400
    
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
            video_start_time=video_start_time,
            camera_role=camera_role
        )
        
        return jsonify({
            'success': True,
            'session_id': session_id,
            'camera_role': camera_role,
            'status': job.status,
            'message': f'Processing started for {camera_role} camera'
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
