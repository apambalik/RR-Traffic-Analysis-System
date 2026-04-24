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
            stats_to_save = camera_stats

            # In continue mode and periodic batched writes, the current in-memory
            # run starts with a fresh event list. Merge persisted + current events
            # so we preserve full camera history across runs without duplicating
            # already-written events from prior batches.
            if update_events:
                existing_events = session_ref.child(f'events_{camera_role}').get()
                merged_events = self._merge_event_dicts(
                    self._normalize_event_list(existing_events),
                    [event.to_dict() for event in session_data.events]
                )
                data[f'events_{camera_role}'] = merged_events
                stats_to_save = self._calculate_statistics_from_event_dicts(merged_events)

            # Save camera-specific statistics (won't overwrite other camera)
            data[f'statistics_{camera_role}'] = stats_to_save
            
            # Also update combined statistics by fetching existing and merging
            self._update_combined_statistics(session_ref, camera_role, stats_to_save)
        else:
            # Legacy: save directly to statistics
            data['statistics'] = camera_stats
        
        # Only include events if explicitly requested (e.g., at end of session)
        if update_events:
            if not camera_role:
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
            
            # Sum raw per-camera counts first, then derive clamped values.
            # This avoids the "sum of clamped != clamped sum" pitfall when one
            # camera is over-counted on IN and the other on OUT.
            total_in = entry_stats.get('vehicles_in', 0) + exit_stats.get('vehicles_in', 0)
            total_out = entry_stats.get('vehicles_out', 0) + exit_stats.get('vehicles_out', 0)

            # Raw people sums (with fallback for legacy stats that don't expose them)
            people_in_min = entry_stats.get('people_in_min', 0) + exit_stats.get('people_in_min', 0)
            people_in_max = entry_stats.get('people_in_max', 0) + exit_stats.get('people_in_max', 0)
            people_out_min = entry_stats.get('people_out_min', 0) + exit_stats.get('people_out_min', 0)
            people_out_max = entry_stats.get('people_out_max', 0) + exit_stats.get('people_out_max', 0)

            has_raw_people = any(
                key in entry_stats or key in exit_stats
                for key in ('people_in_min', 'people_in_max', 'people_out_min', 'people_out_max')
            )

            if has_raw_people:
                on_site_min = max(0, people_in_min - people_out_min)
                on_site_max = max(0, people_in_max - people_out_max)
            else:
                # Legacy fallback: per-camera values are already clamped,
                # so we can only sum them. Accepted as "best effort".
                on_site_min = (entry_stats.get('people_on_site_min', 0)
                               + exit_stats.get('people_on_site_min', 0))
                on_site_max = (entry_stats.get('people_on_site_max', 0)
                               + exit_stats.get('people_on_site_max', 0))

            combined = {
                'vehicles_in': total_in,
                'vehicles_out': total_out,
                'net_vehicles': max(0, total_in - total_out),
                'people_in_min': people_in_min,
                'people_in_max': people_in_max,
                'people_out_min': people_out_min,
                'people_out_max': people_out_max,
                'people_on_site_min': on_site_min,
                'people_on_site_max': on_site_max,
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

    def _normalize_event_list(self, events) -> list:
        """Normalize Firebase event payload into a list of dict events."""
        if not events:
            return []
        if isinstance(events, list):
            return [e for e in events if isinstance(e, dict)]
        if isinstance(events, dict):
            return [e for _, e in sorted(events.items()) if isinstance(e, dict)]
        return []

    def _event_fingerprint(self, event: dict) -> tuple:
        """Stable event identity for de-duplication across batched saves."""
        return (
            event.get('timestamp'),
            event.get('vehicle_type'),
            event.get('direction'),
            event.get('seats_min'),
            event.get('seats_max')
        )

    def _merge_event_dicts(self, existing_events: list, new_events: list) -> list:
        """Append new unique events while preserving chronological order."""
        merged = list(existing_events)
        seen = {self._event_fingerprint(e) for e in merged}

        for event in new_events:
            fp = self._event_fingerprint(event)
            if fp in seen:
                continue
            merged.append(event)
            seen.add(fp)

        merged.sort(key=lambda e: e.get('timestamp', ''))
        return merged

    def _calculate_statistics_from_event_dicts(self, events: list) -> dict:
        """Recompute camera statistics from merged persisted event dicts."""
        vehicles_in = sum(1 for e in events if e.get('direction') == 'IN')
        vehicles_out = sum(1 for e in events if e.get('direction') == 'OUT')

        people_in_min = sum(int(e.get('seats_min', 0) or 0) for e in events if e.get('direction') == 'IN')
        people_in_max = sum(int(e.get('seats_max', 0) or 0) for e in events if e.get('direction') == 'IN')
        people_out_min = sum(int(e.get('seats_min', 0) or 0) for e in events if e.get('direction') == 'OUT')
        people_out_max = sum(int(e.get('seats_max', 0) or 0) for e in events if e.get('direction') == 'OUT')

        distribution = {}
        for event in events:
            vehicle_type = event.get('vehicle_type')
            if not vehicle_type:
                continue
            distribution[vehicle_type] = distribution.get(vehicle_type, 0) + 1

        return {
            'vehicles_in': vehicles_in,
            'vehicles_out': vehicles_out,
            'net_vehicles': max(0, vehicles_in - vehicles_out),
            'people_in_min': people_in_min,
            'people_in_max': people_in_max,
            'people_out_min': people_out_min,
            'people_out_max': people_out_max,
            'people_on_site_min': max(0, people_in_min - people_out_min),
            'people_on_site_max': max(0, people_in_max - people_out_max),
            'vehicle_distribution': distribution
        }
    
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