from flask import Blueprint, render_template, jsonify, session
from flask_socketio import emit
from app import socketio
from app.services.firebase_service import FirebaseService
from app.services.processing_service import get_job_status
from app.models import SessionData

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
