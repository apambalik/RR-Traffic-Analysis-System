# Real-time Vehicle Detection and Traffic Analysis System for Malaysia Rest & Recreation (R&R) Stops
## Description of the system:
- using RF-Detr Base model (roboflow's) for detecting and classifying vehicles entering and exiting the R&R stops from surveillance footage (video file or live camera feed) into sedan, SUV, pickup, van, motorcycle, bus or truck.
- track (using bytetrack) and count (once the vehicle crosses a user-defined line), and calculate the people flow (using the data of the min and max seat capacity of each vehicle type). E,g,. Sedan - min = 1, max = 5.
- after user uploaded or selected the surveillance footage, user will be prompt to draw the line on first frame extracted.
- The data is logged, saved to Firebase, and displayed in the dashboard. 
- Include: key performance indicators that summarise the current state (including an estimated on-site people range (expressed as a bounded interval) and net vehicle movement derived from inbound and outbound counts), visualisation of the historical data in charts, and might include a prediction on the people flow in the future
- The annotated vehicle dataset is using one found from Roboflow (imbalanced classes, will improve in the future), include the 7 classes: sedan, SUV, pickup, van, motorcycle, bus or truck.
- Will deployed using Flask and Firebase Realtime Database.


### Seat-Capacity Mapping:

| Vehicle Type | Seat Capacity |
|--------------|---------------|
| Sedan        | 1–5           |
| SUV          | 1–8           |
| Pickup       | 1–6           |
| Van          | 1–15          |
| Bus          | 1–50          |
| Truck        | 1–3           |
| Motorcycle   | 1–2           |


## Project Structure
```
rr-traffic-analysis-system/
├── app/
│   ├── __init__.py              # Flask app factory
│   ├── config.py                # App configuration (Secret keys, Roboflow API Key)
│   ├── models.py                # Data Classes (e.g., class VehicleLog, class TrafficStat)
│   ├── routes/
│   │   ├── __init__.py
│   │   ├── dashboard.py         # Renamed from 'main.py' for clarity
│   │   └── setup.py             # Renamed from 'config.py' to avoid confusion with app/config.py
│   ├── services/
│   │   ├── __init__.py
│   │   ├── video_processor.py   # The RF-DETR & ByteTrack Logic (Threaded)
│   │   ├── firebase_service.py  # Handles 'logging' and 'real-time' DB pushes
│   │   └── processing_service.py  
│   ├── static/
│   │   ├── css/
│   │   │   └── style.css
│   │   └── js/
│   │       ├── dashboard.js     # Charts.js logic for polling Firebase
│   │       └── setup_canvas.js  # Renamed: Logic for drawing the line over the video frame
│   ├── templates/
│   │   ├── base.html
│   │   ├── dashboard.html
│   │   └── setup.html
│   └── utils/
│       ├── __init__.py
│       └── math_utils.py
│       
├── model_data/                  # Store .pt weights
├── uploads/                     # Store temp user videos here
├── output/                      # Processed videos
├── requirements.txt
├── .env                         # Store ROBOFLOW_API_KEY and FIREBASE_CREDENTIALS here
└── run.py
```

## Plan

Proposed UI/UX: "The Analyst Workbench"
Instead of a static dashboard, treat the page as a workspace with two states.

**Layout Strategy**
- Left Sidebar (Collapsible): This replaces the "Setup Page." It holds the inputs for Video Source and Camera Role.

- Center Stage (The Player): A large video container that toggles between "Raw Video" (for drawing lines) and "Processed Stream" (for viewing results).

- Bottom/Right Panel: The Analytics (Charts, Logs) that update as the video plays.

**State 1: Configuration Mode (Default on Load)**
- Sidebar: Open. User sees "Upload Video" and "Camera Role: Entry/Exit".

- Center: Shows the First Frame of the video.

- Action: User draws the line directly on this frame.

- Button: A large "Start Analysis" button is visible.

**State 2: Analysis Mode (After Clicking Start)**
- Sidebar: Automatically collapses or switches to "Job Status" (Progress bar).

- Center: Switches to the Processed Video Feed (showing bounding boxes).

- Action: The user watches the analysis.

- Button: "Stop/Edit" button appears to return to State 1