import firebase_admin
from firebase_admin import credentials, db
from datetime import datetime
from app.config import Config
from app.models import SessionData

class FirebaseService:
    _instance = None
    
    def __new__(cls):
        if cls._instance is None:
            cls._instance = super(FirebaseService, cls).__new__(cls)
            cls._instance._initialize()
        return cls._instance
    
    def _initialize(self):
        """Initialize Firebase connection"""
        if not firebase_admin._apps:
            cred = credentials.Certificate(Config.FIREBASE_CREDENTIALS)
            firebase_admin.initialize_app(cred, {
                'databaseURL': Config.FIREBASE_DATABASE_URL
            })
        self.ref = db.reference('/')
    
    def save_session(self, session_data: SessionData, update_events=False, camera_role: str = None):
        """Save session data. By default, DO NOT overwrite the events list.
        
        If camera_role is provided, saves camera-specific statistics that won't overwrite
        the other camera's data.
        """
        session_ref = self.ref.child('sessions').child(session_data.session_id)
        
        # Get current camera stats
        camera_stats = session_data.get_statistics()
        
        data = {
            'location': session_data.location,
            'start_time': session_data.start_time.isoformat(),
            'line_coordinates': session_data.line_coordinates
        }
        
        if camera_role:
            # Save camera-specific statistics (won't overwrite other camera)
            data[f'statistics_{camera_role}'] = camera_stats
            
            # Also update combined statistics by fetching existing and merging
            self._update_combined_statistics(session_ref, camera_role, camera_stats)
        else:
            # Legacy: save directly to statistics
            data['statistics'] = camera_stats
        
        # Only include events if explicitly requested (e.g., at end of session)
        if update_events:
            if camera_role:
                data[f'events_{camera_role}'] = [event.to_dict() for event in session_data.events]
            else:
                data['events'] = [event.to_dict() for event in session_data.events]
            
        session_ref.update(data)
    
    def _update_combined_statistics(self, session_ref, camera_role: str, camera_stats: dict):
        """Merge camera statistics into combined statistics"""
        try:
            # Get existing combined stats
            existing = session_ref.child('statistics').get() or {}
            existing_entry = session_ref.child('statistics_ENTRY').get() or {}
            existing_exit = session_ref.child('statistics_EXIT').get() or {}
            
            # Update the appropriate camera stats
            if camera_role == 'ENTRY':
                entry_stats = camera_stats
                exit_stats = existing_exit
            else:
                entry_stats = existing_entry
                exit_stats = camera_stats
            
            # Calculate combined statistics
            combined = {
                'vehicles_in': (entry_stats.get('vehicles_in', 0) + exit_stats.get('vehicles_in', 0)),
                'vehicles_out': (entry_stats.get('vehicles_out', 0) + exit_stats.get('vehicles_out', 0)),
                'net_vehicles': (entry_stats.get('net_vehicles', 0) + exit_stats.get('net_vehicles', 0)),
                'people_on_site_min': (entry_stats.get('people_on_site_min', 0) + exit_stats.get('people_on_site_min', 0)),
                'people_on_site_max': (entry_stats.get('people_on_site_max', 0) + exit_stats.get('people_on_site_max', 0)),
                'vehicle_distribution': self._merge_distributions(
                    entry_stats.get('vehicle_distribution', {}),
                    exit_stats.get('vehicle_distribution', {})
                )
            }
            
            session_ref.child('statistics').set(combined)
        except Exception as e:
            print(f"Error updating combined statistics: {e}")
    
    def _merge_distributions(self, entry_dist: dict, exit_dist: dict) -> dict:
        """Merge vehicle distributions (net = entry - exit)"""
        all_types = set(list(entry_dist.keys()) + list(exit_dist.keys()))
        merged = {}
        for vehicle_type in all_types:
            merged[vehicle_type] = entry_dist.get(vehicle_type, 0) - exit_dist.get(vehicle_type, 0)
        return merged
    
    def save_event(self, session_id: str, event):
        """
        [DEPRECATED] Save individual event to Firebase.
        
        NOTE: This method is deprecated for efficiency reasons.
        Use save_session() with update_events=True to batch events instead.
        Individual writes are expensive - batching reduces Firebase costs by 80-95%.
        """
        events_ref = self.ref.child('sessions').child(session_id).child('events')
        events_ref.push(event.to_dict())
        
        # Update statistics
        self._update_statistics(session_id)
    
    def _update_statistics(self, session_id: str):
        """Update session statistics"""
        # This would recalculate and update statistics in real-time
        pass
    
    def get_session_data(self, session_id: str):
        """Retrieve session data from Firebase"""
        session_ref = self.ref.child('sessions').child(session_id)
        return session_ref.get()
    
    def get_recent_sessions(self, limit: int = 10):
        """Get recent sessions"""
        sessions_ref = self.ref.child('sessions')
        return sessions_ref.order_by_key().limit_to_last(limit).get()