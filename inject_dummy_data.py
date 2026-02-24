"""
Injects realistic dummy traffic session data into Firebase for testing
the historical people-flow statistics chart.

Usage:
    python inject_dummy_data.py
"""

import firebase_admin
from firebase_admin import credentials, db
from datetime import datetime, timedelta
import random
import os
import json
from dotenv import load_dotenv

load_dotenv()

VEHICLE_CAPACITY = {
    'Sedan':      {'min': 1, 'max': 5},
    'SUV':        {'min': 1, 'max': 8},
    'Pickup':     {'min': 1, 'max': 6},
    'Van':        {'min': 1, 'max': 15},
    'Motorcycle': {'min': 1, 'max': 2},
    'Bus':        {'min': 1, 'max': 50},
    'Truck':      {'min': 1, 'max': 3},
}

VEHICLE_WEIGHTS = {
    'Sedan': 0.35, 'SUV': 0.20, 'Motorcycle': 0.15,
    'Pickup': 0.12, 'Van': 0.08, 'Truck': 0.05, 'Bus': 0.05,
}


def _hourly_multiplier(hour: int) -> float:
    """Realistic traffic curve: busy midday, quiet at night."""
    if hour < 6:
        return 0.1
    elif hour < 9:
        return 0.6
    elif hour < 12:
        return 1.0
    elif hour < 14:
        return 1.3
    elif hour < 17:
        return 0.9
    elif hour < 20:
        return 1.1
    return 0.3


def generate_session(start_dt: datetime, location: str = "R&R Skudai") -> dict:
    is_weekend = start_dt.weekday() >= 5
    base = random.randint(30, 80) if is_weekend else random.randint(15, 50)
    total_vehicles = int(base * _hourly_multiplier(start_dt.hour))

    vehicle_types = list(VEHICLE_WEIGHTS.keys())
    weights = list(VEHICLE_WEIGHTS.values())

    events = []
    vehicles_in = vehicles_out = 0
    people_min_in = people_max_in = 0
    people_min_out = people_max_out = 0
    distribution: dict[str, int] = {}

    for _ in range(total_vehicles):
        vtype = random.choices(vehicle_types, weights=weights, k=1)[0]
        direction = random.choice(['IN', 'IN', 'IN', 'OUT', 'OUT'])
        cap = VEHICLE_CAPACITY[vtype]
        seats_min = cap['min']
        seats_max = random.randint(cap['min'], cap['max'])
        ts = start_dt + timedelta(minutes=random.randint(0, 120))

        events.append({
            'vehicle_type': vtype,
            'direction': direction,
            'timestamp': ts.isoformat(),
            'seats_min': seats_min,
            'seats_max': seats_max,
        })

        distribution[vtype] = distribution.get(vtype, 0) + (1 if direction == 'IN' else -1)

        if direction == 'IN':
            vehicles_in += 1
            people_min_in += seats_min
            people_max_in += seats_max
        else:
            vehicles_out += 1
            people_min_out += seats_min
            people_max_out += seats_max

    session_id = f"dummy_{start_dt.strftime('%Y%m%d_%H%M%S')}_{random.randint(1000, 9999)}"

    return {
        session_id: {
            'location': location,
            'start_time': start_dt.isoformat(),
            'statistics': {
                'vehicles_in': vehicles_in,
                'vehicles_out': vehicles_out,
                'net_vehicles': vehicles_in - vehicles_out,
                'people_on_site_min': people_min_in - people_min_out,
                'people_on_site_max': people_max_in - people_max_out,
                'vehicle_distribution': distribution,
            },
            'events_ENTRY': [e for e in events if e['direction'] == 'IN'],
            'events_EXIT':  [e for e in events if e['direction'] == 'OUT'],
        }
    }


def inject_data(days_back: int = 90, sessions_per_day: tuple = (2, 6)):
    creds_json = os.environ.get('FIREBASE_CREDENTIALS_JSON')
    creds_path = os.environ.get('FIREBASE_CREDENTIALS_PATH')

    if creds_json:
        cred = credentials.Certificate(json.loads(creds_json))
    elif creds_path:
        cred = credentials.Certificate(creds_path)
    else:
        print("ERROR: No Firebase credentials found.")
        print("Set FIREBASE_CREDENTIALS_JSON or FIREBASE_CREDENTIALS_PATH in your .env file.")
        return

    db_url = os.environ.get('FIREBASE_DATABASE_URL')
    if not db_url:
        print("ERROR: FIREBASE_DATABASE_URL not set in .env file.")
        return

    if not firebase_admin._apps:
        firebase_admin.initialize_app(cred, {'databaseURL': db_url})

    ref = db.reference('/sessions')
    now = datetime.now()
    total = 0

    for day_offset in range(days_back, 0, -1):
        day = now - timedelta(days=day_offset)
        n = random.randint(*sessions_per_day)

        for _ in range(n):
            hour = random.randint(6, 22)
            minute = random.randint(0, 59)
            session_dt = day.replace(hour=hour, minute=minute, second=0, microsecond=0)
            ref.update(generate_session(session_dt))
            total += 1

        print(f"  {day.strftime('%Y-%m-%d')}: {n} sessions")

    print(f"\nDone — injected {total} sessions over {days_back} days.")


if __name__ == '__main__':
    print("=== RR Traffic Analysis — Dummy Data Injector ===\n")
    raw = input("How many days of history to generate? [90]: ").strip()
    days = int(raw) if raw else 90
    inject_data(days_back=days)
