"""
Processing Service Module

Orchestrates video processing jobs with real-time event streaming.
Manages background processing threads, vehicle tracking, and WebSocket events.
"""

from __future__ import annotations

import os
import queue
import threading
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from enum import Enum
from typing import Dict, List, Optional, Set, Tuple, Any

import cv2
import numpy as np
from PIL import Image
import supervision as sv

from app import socketio
from app.config import Config
from app.models import SessionData, VehicleEvent
from app.services.video_processor import VideoProcessor
from app.services.firebase_service import FirebaseService
from app.state import frame_queues
from app.utils.math_utils import calculate_line_signed_distance


# =============================================================================
# CONSTANTS & CONFIGURATION
# =============================================================================

class ProcessingStatus(str, Enum):
    """Processing job status states."""
    PENDING = 'pending'
    PROCESSING = 'processing'
    COMPLETED = 'completed'
    STOPPED = 'stopped'
    ERROR = 'error'


class CameraRole(str, Enum):
    """Camera role identifiers."""
    ENTRY = 'ENTRY'
    EXIT = 'EXIT'


class VideoSource(str, Enum):
    """Video input source types."""
    FILE = 'file'
    LIVE_STREAM = 'live_stream'


@dataclass
class ProcessingConfig:
    """Configuration constants for video processing."""
    # Frame processing
    PROGRESS_UPDATE_INTERVAL: int = 10      # Emit progress every N frames
    STREAM_FRAME_INTERVAL: int = 2          # Stream every Nth frame
    
    # Tracking thresholds
    TRACK_THRESH: float = 0.25
    TRACK_BUFFER: int = 30
    MATCH_THRESH: float = 0.8
    CROSSING_DISTANCE_THRESHOLD: float = 25.0
    
    # Annotation colors (hex)
    ANNOTATION_COLORS: Tuple[str, ...] = (
        "#ffff00", "#ff9b00", "#ff66ff", "#3399ff",
        "#ff66b2", "#ff8080", "#b266ff"
    )
    LINE_COLOR: Tuple[int, int, int] = (0, 255, 0)  # BGR
    LINE_THICKNESS: int = 2


# Global processing configuration
PROC_CONFIG = ProcessingConfig()

# Global state to track processing jobs: {session_id: {camera_role: job}}
processing_jobs: Dict[str, Dict[str, ProcessingJob]] = {}


# =============================================================================
# DATA CLASSES
# =============================================================================

@dataclass
class TrackingState:
    """Maintains state for vehicle tracking across frames."""
    track_classes: Dict[int, int] = field(default_factory=dict)
    track_distances: Dict[int, Tuple[float, bool]] = field(default_factory=dict)
    counted_ids: Set[int] = field(default_factory=set)
    
    def reset(self):
        """Clear all tracking state."""
        self.track_classes.clear()
        self.track_distances.clear()
        self.counted_ids.clear()


@dataclass
class ProcessingJob:
    """Represents a video processing job with its configuration and state."""
    session_id: str
    video_path: str
    line_points: List[List[float]]
    location: str
    camera_role: str = CameraRole.ENTRY.value
    video_start_time: datetime = field(default_factory=datetime.now)
    status: str = ProcessingStatus.PENDING.value
    progress: int = 0
    error: Optional[str] = None
    thread: Optional[threading.Thread] = None
    # Live stream support
    is_live_stream: bool = False
    should_stop: bool = False
    frames_processed: int = 0
    
    def to_dict(self) -> dict:
        """Convert job to dictionary for serialization."""
        return {
            'session_id': self.session_id,
            'status': self.status,
            'progress': self.progress,
            'error': self.error,
            'location': self.location,
            'camera_role': self.camera_role,
            'is_live_stream': self.is_live_stream,
            'frames_processed': self.frames_processed
        }
    
    def stop(self) -> None:
        """Signal the job to stop processing."""
        self.should_stop = True
    
    @property
    def line_points_int(self) -> Tuple[Tuple[int, int], Tuple[int, int]]:
        """Get line points as integer tuples."""
        return (
            (int(self.line_points[0][0]), int(self.line_points[0][1])),
            (int(self.line_points[1][0]), int(self.line_points[1][1]))
        )


# =============================================================================
# PUBLIC API
# =============================================================================

def start_processing(
    session_id: str,
    video_path: str,
    line_points: List[List[float]],
    location: str,
    video_start_time: datetime = None,
    camera_role: str = CameraRole.ENTRY.value,
    is_live_stream: bool = False
) -> ProcessingJob:
    """
    Start video processing in a background thread.
    
    Args:
        session_id: Unique identifier for the session
        video_path: Path to the video file or stream URL
        line_points: Counting line coordinates [[x1,y1], [x2,y2]]
        location: Location name for the session
        video_start_time: Timestamp for the video start
        camera_role: 'ENTRY' or 'EXIT' camera designation
        is_live_stream: Whether the source is a live stream (RTSP/HTTP)
        
    Returns:
        ProcessingJob instance for tracking progress
    """
    # Check for existing job and ensure it is fully stopped
    if session_id in processing_jobs and camera_role in processing_jobs[session_id]:
        existing_job = processing_jobs[session_id][camera_role]
        
        # Signal stop if it's still running
        if existing_job.status == ProcessingStatus.PROCESSING.value:
            print(f"Stopping existing thread for {camera_role} before restart...")
            existing_job.stop()
            
            # Wait for the thread to actually finish (prevent queue conflict)
            if existing_job.thread and existing_job.thread.is_alive():
                existing_job.thread.join(timeout=5.0)
                print(f"Existing thread for {camera_role} terminated.")

    # Clear stale frames from queue
    _clear_frame_queue(camera_role)
    
    # Auto-detect live stream if not explicitly set
    if not is_live_stream:
        is_live_stream = _is_live_stream(video_path)
    
    # Create job
    job = ProcessingJob(
        session_id=session_id,
        video_path=video_path,
        line_points=line_points,
        location=location,
        camera_role=camera_role,
        video_start_time=video_start_time or datetime.now(),
        is_live_stream=is_live_stream
    )
    
    # Store job in global registry
    if session_id not in processing_jobs:
        processing_jobs[session_id] = {}
    processing_jobs[session_id][camera_role] = job
    
    # Start background thread
    job.thread = threading.Thread(
        target=_run_processing_job,
        args=(job,),
        daemon=True,
        name=f"ProcessingJob-{session_id}-{camera_role}"
    )
    job.thread.start()
    
    return job


def stop_processing(session_id: str, camera_role: str = None) -> bool:
    """
    Stop a running processing job.
    
    Args:
        session_id: The session ID to stop
        camera_role: Specific camera to stop, or None to stop all
        
    Returns:
        True if job(s) were signaled to stop, False if not found
    """
    if session_id not in processing_jobs:
        return False
    
    stopped = False
    jobs = processing_jobs[session_id]
    
    if camera_role:
        # Stop specific camera
        if camera_role in jobs:
            jobs[camera_role].stop()
            stopped = True
    else:
        # Stop all cameras in session
        for job in jobs.values():
            job.stop()
            stopped = True
    
    return stopped


def _is_live_stream(video_path: str) -> bool:
    """Check if the video source is a live stream URL."""
    if not video_path:
        return False
    return video_path.lower().startswith(('rtsp://', 'http://', 'https://', 'rtmp://'))


def get_job_status(session_id: str) -> Optional[Dict[str, dict]]:
    """
    Get the status of all processing jobs for a session.
    
    Args:
        session_id: The session to query
        
    Returns:
        Dict mapping camera roles to job status dicts, or None if not found
    """
    if session_id not in processing_jobs:
        return None
    
    return {
        role: job.to_dict() 
        for role, job in processing_jobs[session_id].items()
    }


# =============================================================================
# BACKGROUND PROCESSING
# =============================================================================

def _run_processing_job(job: ProcessingJob) -> None:
    """
    Background thread function that processes video and emits events.
    
    Args:
        job: The processing job to execute
    """
    job.status = ProcessingStatus.PROCESSING.value
    _emit_status_update(job)
    
    try:
        # Initialize services
        processor = VideoProcessor(model_path=Config.MODEL_PATH)
        firebase = FirebaseService()
        
        # Create session data container
        session_data = SessionData(job.session_id, job.location)
        session_data.line_coordinates = job.line_points
        
        # Process based on source type
        if job.is_live_stream:
            _process_live_stream(processor, firebase, job, session_data)
        else:
            _process_video(processor, firebase, job, session_data)
        
        # Save final results
        firebase.save_session(session_data, camera_role=job.camera_role)
        
        # Mark complete (or stopped for live streams)
        if job.should_stop:
            job.status = ProcessingStatus.STOPPED.value
        else:
            job.status = ProcessingStatus.COMPLETED.value
            job.progress = 100
        
        _emit_status_update(job)
        _emit_processing_complete(job, session_data.get_statistics())
        
    except Exception as e:
        job.status = ProcessingStatus.ERROR.value
        job.error = str(e)
        _emit_status_update(job)
        _emit_error(job, str(e))
        print(f"Processing error for {job.camera_role}: {e}")


def _process_video(
    processor: VideoProcessor,
    firebase: FirebaseService,
    job: ProcessingJob,
    session_data: SessionData
) -> str:
    """
    Process video frame by frame with tracking and event emission.
    
    Args:
        processor: VideoProcessor instance for detection
        firebase: FirebaseService for persistence
        job: Current processing job
        session_data: Session data container
        
    Returns:
        Path to the processed output video
    """
    # Initialize video capture
    cap = cv2.VideoCapture(job.video_path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    
    # Setup video writer
    output_path = _create_video_writer(job, cap, fps)
    writer = cv2.VideoWriter(
        output_path,
        cv2.VideoWriter_fourcc(*"mp4v"),
        fps,
        (Config.FRAME_WIDTH, Config.FRAME_HEIGHT)
    )
    
    # Initialize tracker and annotators
    tracker = _create_tracker(fps)
    annotators = _create_annotators()
    
    # Tracking state
    tracking = TrackingState()
    
    # Processing state
    frame_queue = frame_queues.get(job.camera_role)
    frame_idx = 0
    last_event_count = 0
    
    try:
        while True:
            ret, frame = cap.read()
            if not ret:
                break
            
            # Process frame
            annotated_frame = _process_single_frame(
                frame=frame,
                processor=processor,
                tracker=tracker,
                annotators=annotators,
                tracking=tracking,
                job=job,
                session_data=session_data,
                frame_idx=frame_idx,
                fps=fps
            )
            
            # Write to output
            writer.write(annotated_frame)
            
            # Stream frame for live display
            _stream_frame(frame_queue, annotated_frame, frame_idx)
            
            # Periodic updates
            if frame_idx % PROC_CONFIG.PROGRESS_UPDATE_INTERVAL == 0:
                last_event_count = _handle_periodic_updates(
                    job=job,
                    session_data=session_data,
                    firebase=firebase,
                    total_frames=total_frames,
                    frame_idx=frame_idx,
                    last_event_count=last_event_count
                )
            
            frame_idx += 1
            
    finally:
        cap.release()
        writer.release()
    
    return output_path


def _process_live_stream(
    processor: VideoProcessor,
    firebase: FirebaseService,
    job: ProcessingJob,
    session_data: SessionData
) -> None:
    """
    Process live stream continuously until stopped.
    
    Key differences from file processing:
    - No total_frames (runs indefinitely)
    - Handles reconnection on failure
    - Runs until job.should_stop is True
    - No video file output (streaming only)
    
    Args:
        processor: VideoProcessor instance for detection
        firebase: FirebaseService for persistence
        job: Current processing job
        session_data: Session data container
    """
    import time
    
    cap = None
    retry_count = 0
    max_retries = Config.LIVE_STREAM_RETRY_ATTEMPTS
    retry_delay = Config.LIVE_STREAM_RETRY_DELAY
    
    # Initialize tracker and annotators
    fps = 30.0  # Default for live streams
    tracker = _create_tracker(fps)
    annotators = _create_annotators()
    tracking = TrackingState()
    
    frame_queue = frame_queues.get(job.camera_role)
    frame_idx = 0
    last_event_count = 0
    last_save_time = datetime.now()
    
    print(f"Starting live stream processing for {job.camera_role}: {job.video_path}")
    
    try:
        while not job.should_stop:
            # Connect/reconnect to stream
            if cap is None or not cap.isOpened():
                if retry_count >= max_retries:
                    raise ConnectionError(f"Lost connection to stream after {max_retries} retries")
                
                if retry_count > 0:
                    print(f"Reconnecting to stream (attempt {retry_count + 1}/{max_retries})...")
                    _emit_status_update(job)  # Notify client of reconnection attempt
                    time.sleep(retry_delay)
                
                cap = cv2.VideoCapture(job.video_path)
                cap.set(cv2.CAP_PROP_BUFFERSIZE, Config.LIVE_STREAM_BUFFER_SIZE)
                
                if not cap.isOpened():
                    retry_count += 1
                    cap = None
                    continue
                
                # Successfully connected
                actual_fps = cap.get(cv2.CAP_PROP_FPS)
                if actual_fps > 0:
                    fps = actual_fps
                    tracker = _create_tracker(fps)
                
                retry_count = 0
                print(f"Connected to live stream at {fps:.1f} FPS")
            
            # Read frame
            ret, frame = cap.read()
            if not ret:
                retry_count += 1
                cap.release()
                cap = None
                continue
            
            # Reset retry count on successful read
            retry_count = 0
            
            # Process frame
            annotated_frame = _process_single_frame(
                frame=frame,
                processor=processor,
                tracker=tracker,
                annotators=annotators,
                tracking=tracking,
                job=job,
                session_data=session_data,
                frame_idx=frame_idx,
                fps=fps
            )
            
            # Stream frame for live display
            _stream_frame(frame_queue, annotated_frame, frame_idx)
            
            # Update job stats
            job.frames_processed = frame_idx
            
            # Periodic updates (every 10 frames)
            if frame_idx % PROC_CONFIG.PROGRESS_UPDATE_INTERVAL == 0:
                last_event_count = _handle_live_stream_updates(
                    job=job,
                    session_data=session_data,
                    firebase=firebase,
                    frame_idx=frame_idx,
                    last_event_count=last_event_count
                )
                
                # Save to Firebase periodically (every 30 seconds)
                if (datetime.now() - last_save_time).total_seconds() > 30:
                    firebase.save_session(session_data, update_events=False, camera_role=job.camera_role)
                    last_save_time = datetime.now()
            
            frame_idx += 1
            
    finally:
        if cap:
            cap.release()
        print(f"Live stream processing stopped for {job.camera_role}. Frames processed: {frame_idx}")


def _handle_live_stream_updates(
    job: ProcessingJob,
    session_data: SessionData,
    firebase: FirebaseService,
    frame_idx: int,
    last_event_count: int
) -> int:
    """
    Handle periodic updates for live stream processing.
    
    Returns:
        Updated event count
    """
    # For live streams, emit a "live" status instead of progress percentage
    socketio.emit(
        'processing_progress',
        {
            'session_id': job.session_id,
            'progress': -1,  # -1 indicates live stream
            'camera_role': job.camera_role,
            'frames_processed': frame_idx,
            'is_live': True
        },
        room=job.session_id,
        namespace='/'
    )
    
    # Check for new events
    current_count = len(session_data.events)
    if current_count > last_event_count:
        # Emit new events
        for event in session_data.events[last_event_count:]:
            _emit_vehicle_event(job, event)
            firebase.save_event(job.session_id, event)
        
        # Emit updated statistics
        _emit_statistics_update(job, session_data.get_statistics())
    
    return current_count


def _process_single_frame(
    frame: np.ndarray,
    processor: VideoProcessor,
    tracker: sv.ByteTrack,
    annotators: dict,
    tracking: TrackingState,
    job: ProcessingJob,
    session_data: SessionData,
    frame_idx: int,
    fps: float
) -> np.ndarray:
    """
    Process a single video frame: detect, track, annotate, count.
    
    Returns:
        Annotated frame ready for output/streaming
    """
    # Resize and convert
    resized = cv2.resize(frame, (Config.FRAME_WIDTH, Config.FRAME_HEIGHT))
    rgb_frame = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB)
    pil_image = Image.fromarray(rgb_frame)
    
    # Detect and track
    detections = processor.detect(pil_image)
    detections = tracker.update_with_detections(detections)
    
    # Build labels
    labels = _build_detection_labels(detections, processor)
    
    # Annotate frame
    annotated = _annotate_frame(resized, detections, labels, annotators, job)
    
    # Process crossings
    _detect_line_crossings(
        detections=detections,
        processor=processor,
        tracking=tracking,
        job=job,
        session_data=session_data,
        frame_idx=frame_idx,
        fps=fps
    )
    
    return annotated


# =============================================================================
# DETECTION & TRACKING HELPERS
# =============================================================================

def _create_tracker(fps: float) -> sv.ByteTrack:
    """Create and configure ByteTrack tracker."""
    return sv.ByteTrack(
        track_thresh=PROC_CONFIG.TRACK_THRESH,
        track_buffer=PROC_CONFIG.TRACK_BUFFER,
        match_thresh=PROC_CONFIG.MATCH_THRESH,
        frame_rate=int(fps)
    )


def _create_annotators() -> dict:
    """Create supervision annotators for frame visualization."""
    colors = sv.ColorPalette.from_hex(list(PROC_CONFIG.ANNOTATION_COLORS))
    
    return {
        'bbox': sv.BoxAnnotator(color=colors),
        'label': sv.LabelAnnotator(color=colors, text_color=sv.Color.BLACK),
        'trace': sv.TraceAnnotator(color=colors)
    }


def _build_detection_labels(detections: sv.Detections, processor: VideoProcessor) -> List[str]:
    """Build label strings for detected objects."""
    if detections.tracker_id is None:
        return []
    
    return [
        f"#{tid} {processor.get_class_name(cid)} {conf:.2f}"
        for tid, cid, conf in zip(
            detections.tracker_id,
            detections.class_id,
            detections.confidence
        )
    ]


def _annotate_frame(
    frame: np.ndarray,
    detections: sv.Detections,
    labels: List[str],
    annotators: dict,
    job: ProcessingJob
) -> np.ndarray:
    """Apply all annotations to a frame."""
    annotated = frame.copy()
    
    # Draw tracking traces, bounding boxes, and labels
    annotated = annotators['trace'].annotate(annotated, detections)
    annotated = annotators['bbox'].annotate(annotated, detections)
    
    if labels:
        annotated = annotators['label'].annotate(annotated, detections, labels)
    
    # Draw counting line
    pt1, pt2 = job.line_points_int
    cv2.line(annotated, pt1, pt2, PROC_CONFIG.LINE_COLOR, PROC_CONFIG.LINE_THICKNESS)
    
    return annotated


def _detect_line_crossings(
    detections: sv.Detections,
    processor: VideoProcessor,
    tracking: TrackingState,
    job: ProcessingJob,
    session_data: SessionData,
    frame_idx: int,
    fps: float
) -> None:
    """
    Detect vehicles crossing the counting line and create events.
    """
    if detections.tracker_id is None:
        return
    
    pt1, pt2 = job.line_points_int
    
    for tracker_id, class_id, xyxy in zip(
        detections.tracker_id,
        detections.class_id,
        detections.xyxy
    ):
        if tracker_id is None:
            continue
        
        # Calculate centroid
        cx = int((xyxy[0] + xyxy[2]) / 2)
        cy = int((xyxy[1] + xyxy[3]) / 2)
        
        # Get signed distance to line
        dist, is_within = calculate_line_signed_distance(pt1, pt2, (cx, cy))
        
        # Update tracking state
        tracking.track_classes[tracker_id] = int(class_id)
        prev_data = tracking.track_distances.get(tracker_id)
        
        # Check for line crossing
        if prev_data is not None and tracker_id not in tracking.counted_ids:
            prev_dist, prev_within = prev_data
            
            # Crossing detected: sign change + close to line + within bounds
            crossed = (
                prev_dist * dist < 0 and
                min(abs(prev_dist), abs(dist)) < PROC_CONFIG.CROSSING_DISTANCE_THRESHOLD and
                (is_within or prev_within)
            )
            
            if crossed:
                _create_crossing_event(
                    tracker_id=tracker_id,
                    processor=processor,
                    tracking=tracking,
                    job=job,
                    session_data=session_data,
                    frame_idx=frame_idx,
                    fps=fps
                )
        
        # Store current distance
        tracking.track_distances[tracker_id] = (dist, is_within)


def _create_crossing_event(
    tracker_id: int,
    processor: VideoProcessor,
    tracking: TrackingState,
    job: ProcessingJob,
    session_data: SessionData,
    frame_idx: int,
    fps: float
) -> None:
    """Create and record a vehicle crossing event."""
    class_id = tracking.track_classes[tracker_id]
    vehicle_type = processor.get_class_name(class_id)
    capacity = processor.get_vehicle_capacity(vehicle_type)
    
    # Direction based on camera role
    direction = 'OUT' if job.camera_role == CameraRole.EXIT.value else 'IN'
    
    # Calculate event timestamp
    time_offset = timedelta(seconds=frame_idx / fps)
    event_time = job.video_start_time + time_offset
    
    event = VehicleEvent(
        vehicle_type=vehicle_type,
        direction=direction,
        timestamp=event_time,
        seats_min=capacity['min'],
        seats_max=capacity['max']
    )
    
    session_data.add_event(event)
    tracking.counted_ids.add(tracker_id)


# =============================================================================
# UTILITY FUNCTIONS
# =============================================================================

def _clear_frame_queue(camera_role: str) -> None:
    """Clear any stale frames from the streaming queue."""
    frame_queue = frame_queues.get(camera_role)
    if not frame_queue:
        return
    
    count = 0
    while not frame_queue.empty():
        try:
            frame_queue.get_nowait()
            count += 1
        except queue.Empty:
            break
    
    if count > 0:
        print(f"Cleared {count} stale frames from {camera_role} queue")


def _create_video_writer(job: ProcessingJob, cap: cv2.VideoCapture, fps: float) -> str:
    """Create output path for processed video."""
    output_filename = f"{job.session_id}_{job.camera_role}_processed.mp4"
    return os.path.join(Config.OUTPUT_FOLDER, output_filename)


def _stream_frame(frame_queue: Optional[queue.Queue], frame: np.ndarray, frame_idx: int) -> None:
    """Stream frame to queue for live display (non-blocking)."""
    if frame_queue is None:
        return
    
    if frame_idx % PROC_CONFIG.STREAM_FRAME_INTERVAL != 0:
        return
    
    try:
        frame_queue.put_nowait(frame.copy())
    except queue.Full:
        pass  # Skip frame if queue is full


def _handle_periodic_updates(
    job: ProcessingJob,
    session_data: SessionData,
    firebase: FirebaseService,
    total_frames: int,
    frame_idx: int,
    last_event_count: int
) -> int:
    """
    Handle periodic progress and event updates.
    
    Returns:
        Updated event count
    """
    # Update progress
    progress = int((frame_idx / total_frames) * 100) if total_frames > 0 else 0
    if progress != job.progress:
        job.progress = progress
        _emit_progress_update(job)
    
    # Check for new events
    current_count = len(session_data.events)
    if current_count > last_event_count:
        # Emit new events
        for event in session_data.events[last_event_count:]:
            _emit_vehicle_event(job, event)
            firebase.save_event(job.session_id, event)
        
        # Emit updated statistics
        _emit_statistics_update(job, session_data.get_statistics())
        
        # Persist to Firebase
        firebase.save_session(session_data, update_events=False, camera_role=job.camera_role)
    
    return current_count


# =============================================================================
# SOCKETIO EVENT EMITTERS
# =============================================================================

def _emit_status_update(job: ProcessingJob) -> None:
    """Emit job status update to connected clients."""
    socketio.emit(
        'processing_status',
        job.to_dict(),
        room=job.session_id,
        namespace='/'
    )


def _emit_progress_update(job: ProcessingJob) -> None:
    """Emit progress percentage update."""
    socketio.emit(
        'processing_progress',
        {
            'session_id': job.session_id,
            'progress': job.progress,
            'camera_role': job.camera_role
        },
        room=job.session_id,
        namespace='/'
    )


def _emit_vehicle_event(job: ProcessingJob, event: VehicleEvent) -> None:
    """Emit a new vehicle detection event."""
    socketio.emit(
        'vehicle_event',
        {
            'session_id': job.session_id,
            'event': event.to_dict(),
            'camera_role': job.camera_role
        },
        room=job.session_id,
        namespace='/'
    )


def _emit_statistics_update(job: ProcessingJob, stats: dict) -> None:
    """Emit updated session statistics."""
    socketio.emit(
        'statistics_update',
        {
            'session_id': job.session_id,
            'statistics': stats,
            'camera_role': job.camera_role
        },
        room=job.session_id,
        namespace='/'
    )


def _emit_processing_complete(job: ProcessingJob, final_stats: dict) -> None:
    """Emit processing completion event."""
    socketio.emit(
        'processing_complete',
        {
            'session_id': job.session_id,
            'statistics': final_stats,
            'camera_role': job.camera_role
        },
        room=job.session_id,
        namespace='/'
    )


def _emit_error(job: ProcessingJob, error_message: str) -> None:
    """Emit processing error event."""
    socketio.emit(
        'processing_error',
        {
            'session_id': job.session_id,
            'error': error_message,
            'camera_role': job.camera_role
        },
        room=job.session_id,
        namespace='/'
    )
