import cv2
import os
from pathlib import Path
from PIL import Image
import supervision as sv
import math
import torch
from rfdetr import RFDETRBase
from datetime import datetime
from app.models import VehicleEvent, SessionData
from app.config import Config
from app.utils.math_utils import calculate_line_signed_distance

class VideoProcessor:
    def __init__(self, model_path: str):
        self.device = 'cuda' if torch.cuda.is_available() else 'cpu'
        print(f"Loading model on: {self.device}")
        self.model = RFDETRBase(pretrain_weights=model_path)
        # Move internal model to device (RFDETRBase might need manual moving 
        # or it might have a .to() method depending on implementation)
        if hasattr(self.model, 'model') and hasattr(self.model.model, 'to'):
             self.model.model.to(self.device)
        self.class_names = ['cars-counter', 'Bus', 'Motorcycle', 'Pickup', 'Sedan', 'SUV', 'Truck', 'Van']
        self.vehicle_capacity = Config.VEHICLE_CAPACITY
        
    def extract_first_frame(self, video_path: str) -> tuple:
        """Extract first frame for line drawing"""
        cap = cv2.VideoCapture(video_path)
        ret, frame = cap.read()
        cap.release()
        
        if not ret:
            raise RuntimeError("Unable to read video")
        
        frame = cv2.resize(frame, (Config.FRAME_WIDTH, Config.FRAME_HEIGHT))
        return frame, (Config.FRAME_WIDTH, Config.FRAME_HEIGHT)
    
    def process_video(self, video_path: str, line_points: list, 
                     session_data: SessionData, 
                     progress_callback=None) -> str:
        """
        Process video with vehicle detection and counting
        Returns path to output video
        """
        cap = cv2.VideoCapture(video_path)
        fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        
        # Setup output video
        fourcc = cv2.VideoWriter_fourcc(*"mp4v")
        output_filename = f"{session_data.session_id}_processed.mp4"
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
        
        try:
            while True:
                ret, frame = cap.read()
                if not ret:
                    break
                
                resized_frame = cv2.resize(frame, (Config.FRAME_WIDTH, Config.FRAME_HEIGHT))
                rgb_frame = cv2.cvtColor(resized_frame, cv2.COLOR_BGR2RGB)
                pil_image = Image.fromarray(rgb_frame)
                
                # Detect vehicles
                detections = self.model.predict(pil_image, 
                                              threshold=Config.CONFIDENCE_THRESHOLD)
                detections = tracker.update_with_detections(detections)
                
                # Build labels
                labels = [
                    f"#{tid} {self.class_names[cid]} {conf:.2f}"
                    for tid, cid, conf in zip(detections.tracker_id, 
                                             detections.class_id, 
                                             detections.confidence)
                ]
                
                # Annotate frame
                annotated_frame = resized_frame.copy()
                annotated_frame = trace_annotator.annotate(annotated_frame, detections)
                annotated_frame = bbox_annotator.annotate(annotated_frame, detections)
                annotated_frame = label_annotator.annotate(annotated_frame, detections, labels)
                
                # Draw counting line (convert to integer tuples)
                pt1 = (int(line_points[0][0]), int(line_points[0][1]))
                pt2 = (int(line_points[1][0]), int(line_points[1][1]))
                cv2.line(annotated_frame, pt1, pt2, (0, 255, 0), 2)
                
                # Count crossings
                self._process_detections(detections, line_points, track_class, 
                                       track_last_dist, counted_track_ids, 
                                       session_data)
                
                # Display counts
                self._draw_counts(annotated_frame, session_data)
                
                writer.write(annotated_frame)
                
                # Progress callback
                if progress_callback and frame_idx % 30 == 0:
                    progress = (frame_idx / total_frames) * 100
                    progress_callback(progress)
                
                frame_idx += 1
                
        finally:
            cap.release()
            writer.release()
        
        return output_path
    
    def _process_detections(self, detections, line_points, track_class,
                           track_last_dist, counted_track_ids, session_data):
        """Process detections and count crossings"""
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
            dist, is_within = calculate_line_signed_distance(lp1, lp2, (cx, cy))
            
            prev_data = track_last_dist.get(tracker_id)
            track_class[tracker_id] = int(class_id)
            
            # Check for crossing
            if prev_data is not None and tracker_id not in counted_track_ids:
                prev_dist, prev_within = prev_data
                
                if (prev_dist * dist < 0 and 
                    min(abs(prev_dist), abs(dist)) < 25.0 and
                    (is_within or prev_within)):
                    
                    cls_name = self.class_names[track_class[tracker_id]]
                    direction = 'IN' if dist > 0 else 'OUT'
                    
                    capacity = self.vehicle_capacity.get(cls_name, {'min': 1, 'max': 1})
                    
                    event = VehicleEvent(
                        vehicle_type=cls_name,
                        direction=direction,
                        timestamp=datetime.now(),
                        seats_min=capacity['min'],
                        seats_max=capacity['max']
                    )
                    
                    session_data.add_event(event)
                    counted_track_ids.add(tracker_id)
            
            track_last_dist[tracker_id] = (dist, is_within)
    
    def _draw_counts(self, frame, session_data):
        """Draw vehicle counts on frame"""
        stats = session_data.get_statistics()
        y_offset = 30
        
        for vehicle_type, count in stats['vehicle_distribution'].items():
            cv2.putText(frame, f"{vehicle_type}: {count}", 
                       (10, y_offset), cv2.FONT_HERSHEY_SIMPLEX, 
                       0.6, (0, 255, 255), 2)
            y_offset += 25