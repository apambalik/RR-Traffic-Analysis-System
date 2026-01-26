"""
Background processing service for video analysis.
Handles video processing in a separate thread and emits real-time updates via SocketIO.
"""
import threading
from datetime import datetime
from app import socketio
from app.services.video_processor import VideoProcessor
from app.services.firebase_service import FirebaseService
from app.models import SessionData

# Global state to track processing jobs
processing_jobs = {}

class ProcessingJob:
    """Represents a video processing job"""
    def __init__(self, session_id: str, video_path: str, line_points: list, 
                 location: str, video_start_time: datetime = None,
                 camera_role: str = 'ENTRY'):
        self.session_id = session_id
        self.video_path = video_path
        self.line_points = line_points
        self.location = location
        self.camera_role = camera_role
        self.video_start_time = video_start_time or datetime.now()
        self.status = 'pending'  # pending, processing, completed, error
        self.progress = 0
        self.error = None
        self.thread = None
        
    def to_dict(self):
        return {
            'session_id': self.session_id,
            'status': self.status,
            'progress': self.progress,
            'error': self.error,
            'location': self.location
        }


def start_processing(session_id: str, video_path: str, line_points: list, 
                    location: str, video_start_time: datetime = None,
                    camera_role: str = 'ENTRY'):
    """
    Start video processing in a background thread.
    Returns immediately after starting the thread.
    """
    job = ProcessingJob(session_id, video_path, line_points, location, video_start_time, camera_role)
    processing_jobs[session_id] = job
    
    # Start processing in background thread
    job.thread = threading.Thread(
        target=_process_video_background,
        args=(job,),
        daemon=True
    )
    job.thread.start()
    
    return job


def get_job_status(session_id: str) -> dict:
    """Get the status of a processing job"""
    job = processing_jobs.get(session_id)
    if job:
        return job.to_dict()
    return None


def _process_video_background(job: ProcessingJob):
    """
    Background thread function that processes video and emits events.
    """
    job.status = 'processing'
    _emit_status_update(job)
    
    try:
        # Initialize services
        video_processor = VideoProcessor(model_path="model_data/checkpoint_best_total.pth")
        firebase_service = FirebaseService()
        
        # Create session data
        session_data = SessionData(job.session_id, job.location)
        session_data.line_coordinates = job.line_points
        
        # Process video with callbacks for real-time updates
        output_path = _process_with_realtime_updates(
            video_processor, 
            job, 
            session_data,
            firebase_service
        )
        
        # Save final session data to Firebase
        firebase_service.save_session(session_data)
        
        job.status = 'completed'
        job.progress = 100
        
        # Emit completion event
        _emit_status_update(job)
        _emit_processing_complete(job, session_data.get_statistics())
        
    except Exception as e:
        job.status = 'error'
        job.error = str(e)
        _emit_status_update(job)
        _emit_error(job, str(e))
        print(f"Processing error: {e}")


def _process_with_realtime_updates(video_processor: VideoProcessor, job: ProcessingJob,
                                   session_data: SessionData, firebase_service: FirebaseService):
    """
    Process video frame by frame with real-time event emissions.
    """
    import cv2
    import os
    from PIL import Image
    import supervision as sv
    from app.config import Config
    from app.models import VehicleEvent
    import math
    
    cap = cv2.VideoCapture(job.video_path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    
    # Setup output video
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    output_filename = f"{job.session_id}_processed.mp4"
    output_path = os.path.join(Config.OUTPUT_FOLDER, output_filename)
    writer = cv2.VideoWriter(output_path, fourcc, fps, 
                           (Config.FRAME_WIDTH, Config.FRAME_HEIGHT))
    
    # Initialize tracker
    tracker = sv.ByteTrack(
        track_thresh=0.25,
        track_buffer=30,
        match_thresh=0.8,
        frame_rate=int(fps)
    )
    
    # Tracking state
    track_class = {}
    track_last_dist = {}
    counted_track_ids = set()
    
    # Annotators
    color = sv.ColorPalette.from_hex([
        "#ffff00", "#ff9b00", "#ff66ff", "#3399ff", 
        "#ff66b2", "#ff8080", "#b266ff"
    ])
    bbox_annotator = sv.BoxAnnotator(color=color)
    label_annotator = sv.LabelAnnotator(color=color, text_color=sv.Color.BLACK)
    trace_annotator = sv.TraceAnnotator(color=color)
    
    frame_idx = 0
    last_event_count = 0
    
    try:
        while True:
            ret, frame = cap.read()
            if not ret:
                break
            
            resized_frame = cv2.resize(frame, (Config.FRAME_WIDTH, Config.FRAME_HEIGHT))
            rgb_frame = cv2.cvtColor(resized_frame, cv2.COLOR_BGR2RGB)
            pil_image = Image.fromarray(rgb_frame)
            
            # Detect vehicles
            detections = video_processor.model.predict(pil_image, 
                                          threshold=Config.CONFIDENCE_THRESHOLD)
            detections = tracker.update_with_detections(detections)
            
            # Build labels
            labels = []
            if detections.tracker_id is not None:
                labels = [
                    f"#{tid} {video_processor.class_names[cid]} {conf:.2f}"
                    for tid, cid, conf in zip(detections.tracker_id, 
                                             detections.class_id, 
                                             detections.confidence)
                ]
            
            # Annotate frame
            annotated_frame = resized_frame.copy()
            annotated_frame = trace_annotator.annotate(annotated_frame, detections)
            annotated_frame = bbox_annotator.annotate(annotated_frame, detections)
            if labels:
                annotated_frame = label_annotator.annotate(annotated_frame, detections, labels)
            
            # Draw counting line
            pt1 = (int(job.line_points[0][0]), int(job.line_points[0][1]))
            pt2 = (int(job.line_points[1][0]), int(job.line_points[1][1]))
            cv2.line(annotated_frame, pt1, pt2, (0, 255, 0), 2)
            
            # Process detections for counting
            _process_frame_detections(
                detections, job.line_points, track_class, track_last_dist,
                counted_track_ids, session_data, video_processor,
                job, frame_idx, fps
            )
            
            # Draw counts on frame
            stats = session_data.get_statistics()
            y_offset = 30
            for vehicle_type, count in stats['vehicle_distribution'].items():
                cv2.putText(annotated_frame, f"{vehicle_type}: {count}", 
                           (10, y_offset), cv2.FONT_HERSHEY_SIMPLEX, 
                           0.6, (0, 255, 255), 2)
                y_offset += 25
            
            writer.write(annotated_frame)
            
            # Update progress and emit events periodically
            if frame_idx % 10 == 0:  # Every 10 frames
                progress = int((frame_idx / total_frames) * 100)
                if progress != job.progress:
                    job.progress = progress
                    _emit_progress_update(job)
                
                # Check if new events occurred
                current_event_count = len(session_data.events)
                if current_event_count > last_event_count:
                    # Emit new events
                    new_events = session_data.events[last_event_count:]
                    for event in new_events:
                        _emit_vehicle_event(job, event)
                        firebase_service.save_event(job.session_id, event)
                    
                    # Emit updated statistics
                    _emit_statistics_update(job, session_data.get_statistics())
                    
                    # Save to Firebase periodically
                    firebase_service.save_session(session_data, update_events=False)
                    
                    last_event_count = current_event_count
            
            frame_idx += 1
            
    finally:
        cap.release()
        writer.release()
    
    return output_path


def _process_frame_detections(detections, line_points, track_class, track_last_dist,
                              counted_track_ids, session_data, video_processor,
                              job, frame_idx, fps):
    """Process detections from a single frame"""
    from datetime import timedelta
    from app.models import VehicleEvent
    import math
    
    if detections.tracker_id is None:
        return
        
    for tracker_id, class_id, xyxy in zip(
        detections.tracker_id, detections.class_id, detections.xyxy
    ):
        if tracker_id is None:
            continue
        
        cx = int((xyxy[0] + xyxy[2]) / 2)
        cy = int((xyxy[1] + xyxy[3]) / 2)
        
        # Convert line points to integers
        lp1 = (int(line_points[0][0]), int(line_points[0][1]))
        lp2 = (int(line_points[1][0]), int(line_points[1][1]))
        
        dist, is_within = _line_signed_distance(lp1, lp2, (cx, cy))
        
        prev_data = track_last_dist.get(tracker_id)
        track_class[tracker_id] = int(class_id)
        
        # Check for crossing
        if prev_data is not None and tracker_id not in counted_track_ids:
            prev_dist, prev_within = prev_data
            
            if (prev_dist * dist < 0 and 
                min(abs(prev_dist), abs(dist)) < 25.0 and
                (is_within or prev_within)):
                
                cls_name = video_processor.class_names[track_class[tracker_id]]
                
                if job.camera_role == 'EXIT':
                    direction = 'OUT'
                else:
                    direction = 'IN'
                
                capacity = video_processor.vehicle_capacity.get(cls_name, {'min': 1, 'max': 1})
                
                # Calculate timestamp based on frame position
                frame_time_offset = timedelta(seconds=frame_idx / fps)
                event_timestamp = job.video_start_time + frame_time_offset
                
                event = VehicleEvent(
                    vehicle_type=cls_name,
                    direction=direction,
                    timestamp=event_timestamp,
                    seats_min=capacity['min'],
                    seats_max=capacity['max']
                )
                
                session_data.add_event(event)
                counted_track_ids.add(tracker_id)
        
        track_last_dist[tracker_id] = (dist, is_within)


def _line_signed_distance(p1, p2, centroid):
    """Calculate signed distance from point to line"""
    import math
    x1, y1 = p1
    x2, y2 = p2
    cx, cy = centroid
    
    dx = x2 - x1
    dy = y2 - y1
    line_len_sq = dx * dx + dy * dy
    
    if line_len_sq == 0:
        return 0.0, False
    
    t = ((cx - x1) * dx + (cy - y1) * dy) / line_len_sq
    margin = 0.1
    is_within_segment = -margin <= t <= 1.0 + margin
    
    a = y2 - y1
    b = x1 - x2
    c = x2 * y1 - x1 * y2
    denom = math.hypot(a, b)
    signed_dist = (a * cx + b * cy + c) / denom if denom != 0 else 0.0
    
    return signed_dist, is_within_segment


# SocketIO event emitters
def _emit_status_update(job: ProcessingJob):
    """Emit job status update"""
    socketio.emit('processing_status', job.to_dict(), namespace='/')


def _emit_progress_update(job: ProcessingJob):
    """Emit progress update"""
    socketio.emit('processing_progress', {
        'session_id': job.session_id,
        'progress': job.progress
    }, namespace='/')


def _emit_vehicle_event(job: ProcessingJob, event):
    """Emit a new vehicle detection event"""
    socketio.emit('vehicle_event', {
        'session_id': job.session_id,
        'event': event.to_dict()
    }, namespace='/')


def _emit_statistics_update(job: ProcessingJob, stats: dict):
    """Emit updated statistics"""
    socketio.emit('statistics_update', {
        'session_id': job.session_id,
        'statistics': stats
    }, namespace='/')


def _emit_processing_complete(job: ProcessingJob, final_stats: dict):
    """Emit processing completion event"""
    socketio.emit('processing_complete', {
        'session_id': job.session_id,
        'statistics': final_stats
    }, namespace='/')


def _emit_error(job: ProcessingJob, error_message: str):
    """Emit processing error event"""
    socketio.emit('processing_error', {
        'session_id': job.session_id,
        'error': error_message
    }, namespace='/')
