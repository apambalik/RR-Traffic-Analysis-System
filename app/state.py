"""
Shared application state.
This module holds global state that needs to be accessed by multiple modules
without causing circular import issues.
"""
import queue

# Frame queues for video streaming (one per camera)
# Processing service pushes frames, dashboard routes consume them
frame_queues = {
    'ENTRY': queue.Queue(maxsize=10),
    'EXIT': queue.Queue(maxsize=10)
}
