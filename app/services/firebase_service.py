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
    
    def save_session(self, session_data: SessionData):
        """Save session data to Firebase"""
        session_ref = self.ref.child('sessions').child(session_data.session_id)
        
        data = {
            'location': session_data.location,
            'start_time': session_data.start_time.isoformat(),
            'statistics': session_data.get_statistics(),
            'events': [event.to_dict() for event in session_data.events],
            'line_coordinates': session_data.line_coordinates
        }
        
        session_ref.set(data)
    
    def save_event(self, session_id: str, event):
        """Save individual event to Firebase"""
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