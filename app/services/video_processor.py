"""
Video Processor Module

Handles vehicle detection using RF-DETR model.
Provides model inference and first frame extraction capabilities.
"""

from __future__ import annotations

import cv2
import numpy as np
from PIL import Image
from typing import TYPE_CHECKING, Tuple, Optional

import torch
from rfdetr import RFDETRBase

from app.config import Config

if TYPE_CHECKING:
    import supervision as sv


# =============================================================================
# CONSTANTS
# =============================================================================

# Vehicle class names from the trained model
VEHICLE_CLASSES = (
    'cars-counter',  # Generic vehicle (index 0)
    'Bus',
    'Motorcycle', 
    'Pickup',
    'Sedan',
    'SUV',
    'Truck',
    'Van'
)


# =============================================================================
# VIDEO PROCESSOR CLASS
# =============================================================================

class VideoProcessor:
    """
    Handles vehicle detection using RF-DETR object detection model.
    
    This class is responsible for:
    - Loading and managing the detection model
    - Running inference on images/frames
    - Extracting video frames for configuration
    
    Attributes:
        device: The device to run inference on ('cuda' or 'cpu')
        model: The RF-DETR detection model
        class_names: List of vehicle class names
        vehicle_capacity: Dict mapping vehicle types to passenger capacity
    """
    
    def __init__(self, model_path: str):
        """
        Initialize the video processor with a pre-trained model.
        
        Args:
            model_path: Path to the model weights file
        """
        self.device = self._get_device()
        self.model = self._load_model(model_path)
        self.class_names = VEHICLE_CLASSES
        self.vehicle_capacity = Config.VEHICLE_CAPACITY
    
    @staticmethod
    def _get_device() -> str:
        """Determine the best available device for inference."""
        device = 'cuda' if torch.cuda.is_available() else 'cpu'
        print(f"VideoProcessor: Using device '{device}'")
        return device
    
    def _load_model(self, model_path: str) -> RFDETRBase:
        """
        Load the RF-DETR model and move to appropriate device.
        
        Args:
            model_path: Path to model weights
            
        Returns:
            Loaded model ready for inference
        """
        model = RFDETRBase(pretrain_weights=model_path)
        
        # Move model to device if supported
        if hasattr(model, 'model') and hasattr(model.model, 'to'):
            model.model.to(self.device)
        
        return model
    
    def detect(self, image: Image.Image, threshold: float = None) -> 'sv.Detections':
        """
        Run vehicle detection on an image.
        
        Args:
            image: PIL Image to run detection on
            threshold: Confidence threshold (uses Config default if None)
            
        Returns:
            Supervision Detections object with detection results
        """
        if threshold is None:
            threshold = Config.CONFIDENCE_THRESHOLD
            
        return self.model.predict(image, threshold=threshold)
    
    def extract_first_frame(self, video_path: str) -> Tuple[np.ndarray, Tuple[int, int]]:
        """
        Extract and resize the first frame from a video file.
        
        Used for displaying the frame during counting line configuration.
        
        Args:
            video_path: Path to the video file
            
        Returns:
            Tuple of (frame as numpy array, (width, height))
            
        Raises:
            RuntimeError: If video cannot be read
        """
        cap = cv2.VideoCapture(video_path)
        
        try:
            ret, frame = cap.read()
            if not ret:
                raise RuntimeError(f"Unable to read video: {video_path}")
            
            # Resize to standard processing dimensions
            frame = cv2.resize(frame, (Config.FRAME_WIDTH, Config.FRAME_HEIGHT))
            return frame, (Config.FRAME_WIDTH, Config.FRAME_HEIGHT)
        finally:
            cap.release()
    
    def get_vehicle_capacity(self, vehicle_type: str) -> dict:
        """
        Get the passenger capacity range for a vehicle type.
        
        Args:
            vehicle_type: The vehicle class name
            
        Returns:
            Dict with 'min' and 'max' passenger counts
        """
        return self.vehicle_capacity.get(vehicle_type, {'min': 1, 'max': 1})
    
    def get_class_name(self, class_id: int) -> str:
        """
        Get the vehicle class name for a class ID.
        
        Args:
            class_id: The numeric class ID from detection
            
        Returns:
            Human-readable class name
        """
        if 0 <= class_id < len(self.class_names):
            return self.class_names[class_id]
        return 'Unknown'
