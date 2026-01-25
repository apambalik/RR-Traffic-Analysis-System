from datetime import datetime
from typing import Dict, Optional

class VehicleEvent:
    """Represents a single vehicle detection event"""
    def __init__(self, vehicle_type: str, direction: str, 
                 timestamp: datetime, seats_min: int, seats_max: int):
        self.vehicle_type = vehicle_type
        self.direction = direction  # 'IN' or 'OUT'
        self.timestamp = timestamp
        self.seats_min = seats_min
        self.seats_max = seats_max
    
    def to_dict(self) -> Dict:
        return {
            'vehicle_type': self.vehicle_type,
            'direction': self.direction,
            'timestamp': self.timestamp.isoformat(),
            'seats_min': self.seats_min,
            'seats_max': self.seats_max
        }

class SessionData:
    """Stores data for a processing session"""
    def __init__(self, session_id: str, location: str):
        self.session_id = session_id
        self.location = location
        self.start_time = datetime.now()
        self.vehicle_counts = {}  # {vehicle_type: count}
        self.events = []  # List of VehicleEvent
        self.line_coordinates = None
        
    def add_event(self, event: VehicleEvent):
        self.events.append(event)
        
    def get_statistics(self) -> Dict:
        """Calculate current statistics"""
        vehicles_in = sum(1 for e in self.events if e.direction == 'IN')
        vehicles_out = sum(1 for e in self.events if e.direction == 'OUT')
        
        people_min = sum(e.seats_min for e in self.events if e.direction == 'IN')
        people_max = sum(e.seats_max for e in self.events if e.direction == 'IN')
        
        people_min_out = sum(e.seats_min for e in self.events if e.direction == 'OUT')
        people_max_out = sum(e.seats_max for e in self.events if e.direction == 'OUT')
        
        return {
            'vehicles_in': vehicles_in,
            'vehicles_out': vehicles_out,
            'net_vehicles': vehicles_in - vehicles_out,
            'people_on_site_min': people_min - people_min_out,
            'people_on_site_max': people_max - people_max_out,
            'vehicle_distribution': self._get_distribution()
        }
    
    def _get_distribution(self) -> Dict[str, int]:
        """Get vehicle type distribution"""
        distribution = {}
        for event in self.events:
            distribution[event.vehicle_type] = distribution.get(event.vehicle_type, 0) + 1
        return distribution