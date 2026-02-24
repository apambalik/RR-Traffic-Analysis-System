from flask import Blueprint, render_template, jsonify, session, Response, request
from flask_socketio import emit
from app import socketio
from app.services.firebase_service import FirebaseService
from app.services.processing_service import get_job_status
from app.models import SessionData
from app.state import frame_queues
from datetime import datetime
from collections import defaultdict
import cv2
import queue
import time

dashboard_bp = Blueprint('dashboard', __name__)
firebase_service = FirebaseService()

@dashboard_bp.route('/')
def index():
    """Main dashboard page"""
    session_id = session.get('current_session')
    location = session.get('location', 'Unknown')
    
    session_data = None
    processing_status = None
    
    if session_id:
        # Check if there's an active processing job
        processing_status = get_job_status(session_id)
        
        # Get session data from Firebase
        session_data = firebase_service.get_session_data(session_id)
    
    return render_template('dashboard.html', 
                         session_data=session_data,
                         session_id=session_id,
                         location=location,
                         processing_status=processing_status)

@dashboard_bp.route('/api/statistics')
def get_statistics():
    """API endpoint for real-time statistics"""
    session_id = session.get('current_session')
    
    if not session_id:
        return jsonify({'error': 'No active session'}), 404
    
    data = firebase_service.get_session_data(session_id)
    if not data:
        return jsonify({
            'vehicles_in': 0,
            'vehicles_out': 0,
            'net_vehicles': 0,
            'people_on_site_min': 0,
            'people_on_site_max': 0,
            'vehicle_distribution': {}
        })
    return jsonify(data.get('statistics', {}))

@dashboard_bp.route('/api/events')
def get_events():
    """API endpoint for event log"""
    session_id = session.get('current_session')
    
    if not session_id:
        return jsonify({'error': 'No active session'}), 404
    
    data = firebase_service.get_session_data(session_id)
    if not data:
        return jsonify([])
    
    events = data.get('events', [])
    
    # Return last 50 events
    return jsonify(events[-50:] if events else [])

@dashboard_bp.route('/api/vehicle-distribution')
def get_vehicle_distribution():
    """API endpoint for vehicle distribution chart"""
    session_id = session.get('current_session')
    
    if not session_id:
        return jsonify({'error': 'No active session'}), 404
    
    data = firebase_service.get_session_data(session_id)
    if not data:
        return jsonify({})
    
    stats = data.get('statistics', {})
    distribution = stats.get('vehicle_distribution', {})
    
    return jsonify(distribution)

@dashboard_bp.route('/api/historical-stats')
def get_historical_stats():
    """Aggregate people flow stats across all sessions by time period."""
    period = request.args.get('period', 'daily')
    start_filter = request.args.get('start')
    end_filter = request.args.get('end')

    start_date = None
    end_date = None
    if start_filter:
        try:
            start_date = datetime.strptime(start_filter, '%Y-%m-%d').date()
        except ValueError:
            pass
    if end_filter:
        try:
            end_date = datetime.strptime(end_filter, '%Y-%m-%d').date()
        except ValueError:
            pass

    all_sessions = firebase_service.get_recent_sessions(limit=1000)
    if not all_sessions:
        return jsonify({'labels': [], 'people_min': [], 'people_max': [],
                        'vehicles_in': [], 'vehicles_out': []})

    buckets = defaultdict(lambda: {
        'people_min': 0, 'people_max': 0, 'vehicles_in': 0, 'vehicles_out': 0
    })

    for session_id, session_data in all_sessions.items():
        start_time_str = session_data.get('start_time', '')
        stats = session_data.get('statistics', {})
        if not start_time_str or not stats:
            continue

        try:
            dt = datetime.fromisoformat(start_time_str)
        except ValueError:
            continue

        session_date = dt.date()
        if start_date and session_date < start_date:
            continue
        if end_date and session_date > end_date:
            continue

        if period == 'hourly':
            key = dt.strftime('%Y-%m-%d %H:00')
        elif period == 'weekly':
            key = f"{dt.isocalendar()[0]}-W{dt.isocalendar()[1]:02d}"
        elif period == 'monthly':
            key = dt.strftime('%Y-%m')
        elif period == 'yearly':
            key = dt.strftime('%Y')
        else:
            key = dt.strftime('%Y-%m-%d')

        buckets[key]['people_min'] += stats.get('people_on_site_min', 0)
        buckets[key]['people_max'] += stats.get('people_on_site_max', 0)
        buckets[key]['vehicles_in'] += stats.get('vehicles_in', 0)
        buckets[key]['vehicles_out'] += stats.get('vehicles_out', 0)

    sorted_keys = sorted(buckets.keys())

    return jsonify({
        'labels': sorted_keys,
        'people_min': [buckets[k]['people_min'] for k in sorted_keys],
        'people_max': [buckets[k]['people_max'] for k in sorted_keys],
        'vehicles_in': [buckets[k]['vehicles_in'] for k in sorted_keys],
        'vehicles_out': [buckets[k]['vehicles_out'] for k in sorted_keys]
    })

@dashboard_bp.route('/api/processing-status')
def get_processing_status():
    """API endpoint to check processing status"""
    session_id = session.get('current_session')
    
    if not session_id:
        return jsonify({'error': 'No active session'}), 404
    
    status = get_job_status(session_id)
    if status:
        return jsonify(status)
    else:
        return jsonify({'status': 'not_found'})


def generate_frames(camera_role):
    """Generator function for streaming MJPEG frames"""
    frame_queue = frame_queues.get(camera_role)
    if not frame_queue:
        print(f"No frame queue found for camera: {camera_role}")
        return
    
    print(f"Starting frame stream for {camera_role} camera")
    last_frame_time = time.time()
    
    while True:
        try:
            # Get frame from queue with timeout
            frame = frame_queue.get(timeout=5.0)
            
            # Encode frame as JPEG
            ret, buffer = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
            if not ret:
                print(f"Failed to encode frame for {camera_role}")
                continue
            
            # Convert to bytes
            frame_bytes = buffer.tobytes()
            
            # Calculate FPS for monitoring
            current_time = time.time()
            fps = 1.0 / (current_time - last_frame_time) if (current_time - last_frame_time) > 0 else 0
            last_frame_time = current_time
            
            if frame_bytes:
                # Yield frame in multipart format
                yield (b'--frame\r\n'
                       b'Content-Type: image/jpeg\r\n\r\n' + frame_bytes + b'\r\n')
            
        except queue.Empty:
            # No frames available - continue waiting
            time.sleep(0.1)
            continue
        except GeneratorExit:
            print(f"Client disconnected from {camera_role} stream")
            break
        except Exception as e:
            print(f"Stream error for {camera_role}: {e}")
            break


@dashboard_bp.route('/video-feed/<camera_role>')
def video_feed(camera_role):
    """Video streaming route for real-time annotated frames"""
    if camera_role not in ['ENTRY', 'EXIT']:
        return jsonify({'error': 'Invalid camera role'}), 404
    
    print(f"Video feed requested for {camera_role} camera")
    
    return Response(
        generate_frames(camera_role),
        mimetype='multipart/x-mixed-replace; boundary=frame'
    )


# WebSocket event handlers
@socketio.on('connect')
def handle_connect():
    """Handle client connection"""
    print('Client connected')
    emit('connected', {'status': 'connected'})

@socketio.on('disconnect')
def handle_disconnect():
    """Handle client disconnection"""
    print('Client disconnected')

@socketio.on('join_session')
def handle_join_session(data):
    """Handle client joining a processing session"""
    from flask_socketio import join_room
    session_id = data.get('session_id')
    if session_id:
        join_room(session_id)
        print(f'Client joined session room: {session_id}')
        emit('session_joined', {'session_id': session_id})

@socketio.on('request_status')
def handle_request_status(data):
    """Handle status request from client"""
    session_id = data.get('session_id')
    if session_id:
        status = get_job_status(session_id)
        if status:
            emit('processing_status', status)
