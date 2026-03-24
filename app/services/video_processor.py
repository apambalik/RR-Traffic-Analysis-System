"""
Video Processor Module

Handles vehicle detection using YOLOv26s with TensorRT / PyTorch backend.
A singleton BatchInferenceEngine owns the single model instance and serves
all camera threads via batched GPU inference, maximising throughput for
10–40 simultaneous live feeds.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import List, Optional, Tuple

import cv2
import numpy as np
import torch
import supervision as sv
from ultralytics import YOLO

from app.config import Config


# =============================================================================
# CONSTANTS
# =============================================================================

VEHICLE_CLASSES = (
    # 'cars-counter',
    'Bus',
    'Motorcycle',
    'Pickup',
    'Sedan',
    'SUV',
    'Truck',
    'Van'
)


# =============================================================================
# BATCH INFERENCE ENGINE (singleton)
# =============================================================================

@dataclass
class _InferenceRequest:
    """A frame submitted by a camera thread, waiting for its result."""
    frame: np.ndarray
    threshold: float
    result: Optional[sv.Detections] = field(default=None, init=False)
    done: threading.Event = field(default_factory=threading.Event)


class BatchInferenceEngine:
    """
    Owns one YOLO model and processes frames from every camera thread in
    batches.  Camera threads call :meth:`submit`, which blocks until the
    batch containing their frame has been processed on the GPU.

    Thread-safe singleton — the first call to :meth:`get_instance` loads the
    model; subsequent calls return the same engine.
    """

    _instance: Optional[BatchInferenceEngine] = None
    _init_lock = threading.Lock()

    def __init__(self, model_path: str, max_batch_size: int, max_wait_ms: float):
        self._model = YOLO(model_path)
        if model_path.endswith('.pt'):
            device = 'cuda' if torch.cuda.is_available() else 'cpu'
            self._model.to(device)

        self.max_batch_size = max_batch_size
        self.max_wait_ms = max_wait_ms

        self._queue: List[_InferenceRequest] = []
        self._queue_lock = threading.Lock()
        self._queue_ready = threading.Condition(self._queue_lock)
        self._running = True

        self._thread = threading.Thread(
            target=self._inference_loop, daemon=True, name="BatchInference"
        )
        self._thread.start()
        print(
            f"BatchInferenceEngine: model='{model_path}'  "
            f"max_batch={max_batch_size}  max_wait={max_wait_ms}ms"
        )

    # ---- singleton accessor ------------------------------------------------

    @classmethod
    def get_instance(
        cls,
        model_path: str | None = None,
        max_batch_size: int | None = None,
        max_wait_ms: float | None = None,
    ) -> BatchInferenceEngine:
        if cls._instance is None:
            with cls._init_lock:
                if cls._instance is None:
                    cls._instance = cls(
                        model_path=model_path or Config.MODEL_PATH,
                        max_batch_size=max_batch_size or Config.BATCH_MAX_SIZE,
                        max_wait_ms=max_wait_ms if max_wait_ms is not None else Config.BATCH_MAX_WAIT_MS,
                    )
        return cls._instance

    # ---- public API (called from camera threads) ----------------------------

    def submit(self, frame: np.ndarray, threshold: float | None = None) -> sv.Detections:
        """
        Enqueue *frame* for detection and block until the result is ready.
        Safe to call from any number of threads concurrently.
        """
        req = _InferenceRequest(
            frame=frame,
            threshold=threshold if threshold is not None else Config.CONFIDENCE_THRESHOLD,
        )
        with self._queue_ready:
            self._queue.append(req)
            self._queue_ready.notify()

        req.done.wait()
        return req.result  # type: ignore[return-value]

    # ---- background inference loop ------------------------------------------

    def _inference_loop(self) -> None:
        while self._running:
            batch: List[_InferenceRequest] = []

            with self._queue_ready:
                # Sleep until at least one request arrives
                while not self._queue and self._running:
                    self._queue_ready.wait(timeout=0.1)
                if not self._running:
                    break

                # Drain up to max_batch_size, allowing max_wait_ms for the
                # batch to fill before firing a partial batch.
                deadline = time.monotonic() + self.max_wait_ms / 1000.0
                while len(batch) < self.max_batch_size:
                    if self._queue:
                        batch.append(self._queue.pop(0))
                    else:
                        remaining = deadline - time.monotonic()
                        if remaining <= 0:
                            break
                        self._queue_ready.wait(timeout=remaining)

            if not batch:
                continue

            # Use the lowest threshold in the batch so no detections are lost
            threshold = min(r.threshold for r in batch)
            frames = [r.frame for r in batch]

            try:
                results = self._model.predict(frames, conf=threshold, verbose=False)
                for req, res in zip(batch, results):
                    req.result = sv.Detections.from_ultralytics(res)
            except Exception as exc:
                # On failure, give every waiting thread an empty result so
                # they don't hang forever; the error is logged once here.
                print(f"BatchInferenceEngine: inference error — {exc}")
                for req in batch:
                    if req.result is None:
                        req.result = sv.Detections.empty()
            finally:
                for req in batch:
                    req.done.set()

    # ---- lifecycle ----------------------------------------------------------

    def shutdown(self) -> None:
        self._running = False
        with self._queue_ready:
            self._queue_ready.notify_all()
        self._thread.join(timeout=5.0)
        print("BatchInferenceEngine: shut down")

    @classmethod
    def reset(cls) -> None:
        """Shut down and discard the singleton (useful for tests / restarts)."""
        with cls._init_lock:
            if cls._instance is not None:
                cls._instance.shutdown()
                cls._instance = None


# =============================================================================
# VIDEO PROCESSOR (thin per-camera wrapper)
# =============================================================================

class VideoProcessor:
    """
    Lightweight per-camera handle.  Detection is delegated to the shared
    :class:`BatchInferenceEngine`; everything else (class names, capacity
    lookups, frame extraction) is local.
    """

    def __init__(self, model_path: str):
        self._engine = BatchInferenceEngine.get_instance(model_path)
        self.class_names = VEHICLE_CLASSES
        self.vehicle_capacity = Config.VEHICLE_CAPACITY

    def detect(self, image: np.ndarray, threshold: float = None) -> sv.Detections:
        """Submit a BGR frame to the shared engine and block for the result."""
        return self._engine.submit(image, threshold)
    
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
