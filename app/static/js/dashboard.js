/**
 * Dashboard Manager - Handles real-time updates via WebSocket
 */
class DashboardManager {
    constructor() {
        this.socket = null;
        this.sessionId = window.SESSION_ID || null;
        this.charts = {};
        this.eventCount = 0;
        this.maxLogEvents = 50;
        
        this.init();
    }
    
    init() {
        this.setupCharts();
        this.setupSocketIO();
        this.setupTimeFilter();
        
        // Initial data fetch
        if (this.sessionId) {
            this.fetchInitialData();
        }
    }
    
    setupSocketIO() {
        // Connect to SocketIO server
        this.socket = io();
        
        this.socket.on('connect', () => {
            console.log('Connected to server');
            if (this.sessionId) {
                this.socket.emit('join_session', { session_id: this.sessionId });
            }
        });
        
        this.socket.on('disconnect', () => {
            console.log('Disconnected from server');
        });
        
        this.socket.on('connected', (data) => {
            console.log('Server acknowledged connection:', data);
        });
        
        // Processing status updates
        this.socket.on('processing_status', (data) => {
            console.log('Processing status:', data);
            this.updateProcessingStatus(data);
        });
        
        // Progress updates
        this.socket.on('processing_progress', (data) => {
            console.log('Progress:', data.progress + '%');
            this.updateProgress(data.progress);
        });
        
        // New vehicle event
        this.socket.on('vehicle_event', (data) => {
            console.log('New vehicle event:', data.event);
            this.addEventToLog(data.event);
        });
        
        // Statistics update
        this.socket.on('statistics_update', (data) => {
            console.log('Statistics update:', data.statistics);
            this.updateStatistics(data.statistics);
            this.updateDistributionChart(data.statistics.vehicle_distribution);
        });
        
        // Processing complete
        this.socket.on('processing_complete', (data) => {
            console.log('Processing complete:', data);
            this.onProcessingComplete(data);
        });
        
        // Processing error
        this.socket.on('processing_error', (data) => {
            console.error('Processing error:', data.error);
            this.onProcessingError(data.error);
        });
    }
    
    async fetchInitialData() {
        try {
            // Fetch statistics
            const statsResponse = await fetch('/api/statistics');
            if (statsResponse.ok) {
                const stats = await statsResponse.json();
                this.updateStatistics(stats);
                if (stats.vehicle_distribution) {
                    this.updateDistributionChart(stats.vehicle_distribution);
                }
            }
            
            // Fetch events
            const eventsResponse = await fetch('/api/events');
            if (eventsResponse.ok) {
                const events = await eventsResponse.json();
                this.eventCount = events.length;
                document.getElementById('event-count').textContent = `${this.eventCount} events`;
            }
        } catch (error) {
            console.error('Error fetching initial data:', error);
        }
    }
    
    updateProcessingStatus(data) {
        const banner = document.getElementById('processing-banner');
        const text = document.getElementById('processing-text');
        const entryStatus = document.getElementById('entry-status');
        
        if (data.status === 'processing') {
            banner.classList.remove('hidden');
            text.textContent = `Processing video... ${data.progress}%`;
            if (entryStatus) entryStatus.textContent = 'PROCESSING';
        } else if (data.status === 'completed') {
            banner.classList.add('hidden');
            if (entryStatus) entryStatus.textContent = 'COMPLETED';
        } else if (data.status === 'error') {
            banner.classList.add('hidden');
            if (entryStatus) entryStatus.textContent = 'ERROR';
        }
    }
    
    updateProgress(progress) {
        const progressBar = document.getElementById('progress-bar');
        const text = document.getElementById('processing-text');
        
        if (progressBar) {
            progressBar.style.width = `${progress}%`;
        }
        if (text) {
            text.textContent = `Processing video... ${progress}%`;
        }
    }
    
    updateStatistics(stats) {
        // Update KPI values
        const vehiclesIn = document.getElementById('vehicles-in');
        const vehiclesOut = document.getElementById('vehicles-out');
        const netVehicles = document.getElementById('net-vehicles');
        const peopleRange = document.getElementById('people-range');
        
        if (vehiclesIn) vehiclesIn.textContent = stats.vehicles_in || 0;
        if (vehiclesOut) vehiclesOut.textContent = stats.vehicles_out || 0;
        if (netVehicles) netVehicles.textContent = stats.net_vehicles || 0;
        
        if (peopleRange) {
            const min = stats.people_on_site_min || 0;
            const max = stats.people_on_site_max || 0;
            peopleRange.textContent = `${min} - ${max}`;
        }
    }
    
    addEventToLog(event) {
        const tbody = document.getElementById('event-log-body');
        if (!tbody) return;
        
        // Remove "no events" message if present
        const emptyRow = tbody.querySelector('.empty-row');
        if (emptyRow) {
            emptyRow.remove();
        }
        
        // Create new row
        const row = document.createElement('tr');
        row.className = 'new-event';
        
        // Format timestamp
        let timestamp = '--:--:--';
        if (event.timestamp) {
            const ts = event.timestamp;
            if (ts.includes('T')) {
                timestamp = ts.split('T')[1].substring(0, 8);
            } else if (ts.length >= 8) {
                timestamp = ts.substring(ts.length - 8);
            }
        }
        
        // Direction badge class
        const directionClass = event.direction === 'IN' ? 'badge-in' : 'badge-out';
        
        row.innerHTML = `
            <td>${timestamp}</td>
            <td><span class="badge badge-${event.vehicle_type.toLowerCase()}">${event.vehicle_type}</span></td>
            <td><span class="badge ${directionClass}">${event.direction}</span></td>
            <td>${event.seats_min} - ${event.seats_max}</td>
        `;
        
        // Insert at top
        tbody.insertBefore(row, tbody.firstChild);
        
        // Remove excess rows
        while (tbody.children.length > this.maxLogEvents) {
            tbody.removeChild(tbody.lastChild);
        }
        
        // Update event count
        this.eventCount++;
        document.getElementById('event-count').textContent = `${this.eventCount} events`;
        
        // Highlight animation
        setTimeout(() => {
            row.classList.remove('new-event');
        }, 1000);
    }
    
    updateDistributionChart(distribution) {
        if (!this.charts.distribution || !distribution) return;
        
        const labels = Object.keys(distribution);
        const values = Object.values(distribution);
        
        this.charts.distribution.data.labels = labels;
        this.charts.distribution.data.datasets[0].data = values;
        this.charts.distribution.update('none');
    }
    
    onProcessingComplete(data) {
        const banner = document.getElementById('processing-banner');
        const entryStatus = document.getElementById('entry-status');
        
        if (banner) banner.classList.add('hidden');
        if (entryStatus) entryStatus.textContent = 'COMPLETED';
        
        // Show completion notification
        this.showNotification('Processing Complete', 'Video analysis finished successfully!', 'success');
        
        // Update final statistics
        if (data.statistics) {
            this.updateStatistics(data.statistics);
            if (data.statistics.vehicle_distribution) {
                this.updateDistributionChart(data.statistics.vehicle_distribution);
            }
        }
    }
    
    onProcessingError(error) {
        const banner = document.getElementById('processing-banner');
        const entryStatus = document.getElementById('entry-status');
        
        if (banner) banner.classList.add('hidden');
        if (entryStatus) entryStatus.textContent = 'ERROR';
        
        this.showNotification('Processing Error', error, 'error');
    }
    
    showNotification(title, message, type = 'info') {
        // Create notification element
        const notification = document.createElement('div');
        notification.className = `notification notification-${type}`;
        notification.innerHTML = `
            <strong>${title}</strong>
            <p>${message}</p>
        `;
        
        document.body.appendChild(notification);
        
        // Auto-remove after 5 seconds
        setTimeout(() => {
            notification.classList.add('fade-out');
            setTimeout(() => notification.remove(), 300);
        }, 5000);
    }
    
    setupCharts() {
        // Vehicle Distribution Chart
        const distCtx = document.getElementById('distributionChart');
        if (distCtx) {
            this.charts.distribution = new Chart(distCtx, {
                type: 'bar',
                data: {
                    labels: ['Sedan', 'SUV', 'Pickup', 'Motorcycle', 'Van', 'Truck', 'Bus'],
                    datasets: [{
                        label: 'Count',
                        data: [0, 0, 0, 0, 0, 0, 0],
                        backgroundColor: '#00a8ff',
                        borderRadius: 4
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: {
                        duration: 300
                    },
                    plugins: {
                        legend: { display: false }
                    },
                    scales: {
                        y: {
                            beginAtZero: true,
                            grid: { color: '#e2e8f0' }
                        },
                        x: {
                            grid: { display: false }
                        }
                    }
                }
            });
        }

        // People Flow Trend Chart
        const flowCtx = document.getElementById('flowChart');
        if (flowCtx) {
            this.charts.flow = new Chart(flowCtx, {
                type: 'line',
                data: {
                    labels: [],
                    datasets: [
                        {
                            label: 'Actual Flow',
                            data: [],
                            borderColor: '#3b82f6',
                            backgroundColor: 'rgba(59, 130, 246, 0.2)',
                            fill: true,
                            tension: 0.4
                        },
                        {
                            label: 'Predicted Flow',
                            data: [],
                            borderColor: '#ef4444',
                            backgroundColor: 'rgba(239, 68, 68, 0.2)',
                            fill: true,
                            tension: 0.4
                        }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { display: false }
                    },
                    scales: {
                        y: {
                            beginAtZero: true,
                            grid: { color: '#e2e8f0' }
                        },
                        x: {
                            grid: { display: false }
                        }
                    }
                }
            });
        }
    }
    
    setupTimeFilter() {
        document.querySelectorAll('.time-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.time-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                // TODO: Fetch data for selected time period
            });
        });
    }
}

// Note: Initialization moved to end of file to include WorkbenchManager

class WorkbenchManager {
    constructor() {
        // State
        this.currentCameraRole = 'ENTRY';
        this.lineDrawer = null;
        this.isConfigured = false;
        this.lineSet = false;
        
        // Track camera configurations separately
        this.cameraConfigs = {
            'ENTRY': { hasVideo: false, hasLine: false, videoName: '' },
            'EXIT': { hasVideo: false, hasLine: false, videoName: '' }
        };

        // Elements
        this.els = {
            videoUpload: document.getElementById('video-upload'),
            fileName: document.getElementById('file-name-display'),
            startBtn: document.getElementById('btn-start-analysis'),
            clearLineBtn: document.getElementById('clear-line-btn'),
            canvas: document.getElementById('setup-canvas'),
            liveFeed: document.getElementById('live-feed'),
            previewPlayer: document.getElementById('preview-player'),
            placeholder: document.getElementById('stage-placeholder'),
            configStatusText: document.getElementById('config-status-text'),
            configStatusDot: document.getElementById('config-status-dot'),
            processingStatus: document.getElementById('processing-status'),
            locationInput: document.getElementById('location-input'),
            modeLabel: document.getElementById('mode-label'),
            liveBadge: document.getElementById('live-badge')
        };

        this.init();
    }

    init() {
        this.setupEventListeners();
        this.checkExistingSession();
    }

    setupEventListeners() {
        // Handle Video Upload
        if (this.els.videoUpload) {
            this.els.videoUpload.addEventListener('change', (e) => this.handleVideoUpload(e));
        }

        // Handle Clear/Redraw Line
        if (this.els.clearLineBtn) {
            this.els.clearLineBtn.addEventListener('click', () => this.resetLine());
        }

        // Handle Start Analysis
        if (this.els.startBtn) {
            this.els.startBtn.addEventListener('click', () => this.startAnalysis());
        }
    }

    // --- Camera Context Switching (Entry/Exit Tabs) ---
    switchCameraContext(role) {
        this.currentCameraRole = role;
        
        // UI Updates for Tabs
        document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
        const activeId = role === 'ENTRY' ? 'tab-entry' : 'tab-exit';
        document.getElementById(activeId).classList.add('active');
        
        // Update Stage Label
        document.getElementById('stage-label').textContent = 
            `${role.charAt(0).toUpperCase() + role.slice(1).toLowerCase()} Camera Preview`;

        // Update file name display
        const config = this.cameraConfigs[role];
        if (config.videoName) {
            this.els.fileName.textContent = config.videoName;
        } else {
            this.els.fileName.textContent = 'No file selected';
        }
        
        // Load the frame for the selected camera if video exists
        if (config.hasVideo) {
            this.loadFirstFrame();
            this.updateConfigStatus(config.hasLine);
            if (config.hasLine) {
                this.els.clearLineBtn.disabled = false;
            }
        } else {
            // No video for this camera - show placeholder
            this.els.canvas.style.display = 'none';
            this.els.placeholder.style.display = 'block';
            this.updateConfigStatus(false);
            this.els.clearLineBtn.disabled = true;
        }
    }

    // --- Video Upload & First Frame Extraction ---
    async handleVideoUpload(e) {
        console.log('handleVideoUpload called', e);
        
        if (!e.target.files || !e.target.files.length) {
            console.log('No files selected');
            return;
        }

        const file = e.target.files[0];
        console.log('File selected:', file.name, 'Size:', file.size, 'Type:', file.type);
        
        if (this.els.fileName) {
            this.els.fileName.textContent = file.name;
        }
        
        const formData = new FormData();
        formData.append('video', file);
        formData.append('camera_role', this.currentCameraRole);

        try {
            console.log('Uploading to /setup/upload-video for camera:', this.currentCameraRole);
            
            // Use existing endpoint from setup.py
            const response = await fetch('/setup/upload-video', {
                method: 'POST',
                body: formData
            });
            
            console.log('Response status:', response.status);
            const data = await response.json();
            console.log('Response data:', data);

            if (data.success) {
                // Update camera config
                this.cameraConfigs[this.currentCameraRole].hasVideo = true;
                this.cameraConfigs[this.currentCameraRole].videoName = file.name;
                
                console.log('Upload successful, loading first frame...');
                this.loadFirstFrame();
            } else {
                console.error('Upload failed:', data.error);
                alert('Upload failed: ' + data.error);
            }
        } catch (error) {
            console.error('Upload error:', error);
            alert('Error uploading video: ' + error.message);
        }
    }

    async loadFirstFrame() {
        try {
            const response = await fetch(`/setup/get-first-frame?camera_role=${this.currentCameraRole}`);
            const data = await response.json();

            if (data.frame) {
                // UI State: Show Canvas, Hide Placeholder
                this.els.placeholder.style.display = 'none';
                this.els.canvas.style.display = 'block';
                this.els.liveFeed.classList.add('hidden');

                // Initialize Line Drawer
                this.lineDrawer = new LineDrawer('setup-canvas');
                await this.lineDrawer.loadImage('data:image/jpeg;base64,' + data.frame);

                // If line points exist for this camera, restore them
                if (data.line_points) {
                    this.lineDrawer.setLinePoints(data.line_points);
                    this.lineSet = true;
                    this.cameraConfigs[this.currentCameraRole].hasLine = true;
                    this.els.clearLineBtn.disabled = false;
                    this.updateConfigStatus(true);
                } else {
                    // Setup Callback for when line is drawn
                    this.lineDrawer.onLineComplete = (points) => {
                        this.lineSet = true;
                        this.cameraConfigs[this.currentCameraRole].hasLine = true;
                        this.els.clearLineBtn.disabled = false;
                        this.updateConfigStatus(true);
                    };
                    
                    // Update Status
                    this.els.configStatusText.textContent = "Video Loaded. Draw Line.";
                    this.els.configStatusDot.className = "status-dot error"; // Orange/Red until line drawn
                }
            }
        } catch (error) {
            console.error('Error loading frame:', error);
        }
    }

    resetLine() {
        if (this.lineDrawer) {
            this.lineDrawer.reset();
            this.lineSet = false;
            this.cameraConfigs[this.currentCameraRole].hasLine = false;
            this.updateConfigStatus(false);
        }
    }

    updateConfigStatus(ready) {
        if (ready) {
            this.els.configStatusText.textContent = "Ready to Process";
            this.els.configStatusDot.className = "status-dot ready";
            this.els.startBtn.disabled = false;
        } else {
            this.els.configStatusText.textContent = "Configuration Incomplete";
            this.els.configStatusDot.className = "status-dot error";
            this.els.startBtn.disabled = true;
        }
    }

    // --- Processing ---
    async startAnalysis() {
        if (!this.lineSet || !this.lineDrawer) {
            alert("Please draw the counting line first.");
            return;
        }

        // 1. Save Line for current camera
        const linePoints = this.lineDrawer.getLinePoints();
        await fetch('/setup/save-line', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                line_points: linePoints,
                camera_role: this.currentCameraRole
            })
        });

        // 2. UI Updates (Switch to Analysis Mode)
        this.els.processingStatus.classList.remove('hidden');
        this.els.startBtn.disabled = true;
        
        const location = this.els.locationInput.value || 'Unknown';

        // 3. Trigger Processing
        try {
            const response = await fetch('/setup/start-processing', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    location: location,
                    camera_role: this.currentCameraRole
                })
            });
            const data = await response.json();

            if (data.success) {
                // Switch View to "Analysis Mode"
                this.setAnalysisMode(true);
                
                // Join the session room for real-time updates
                if (window.dashboardManager && window.dashboardManager.socket) {
                    window.dashboardManager.sessionId = data.session_id;
                    window.dashboardManager.socket.emit('join_session', { 
                        session_id: data.session_id 
                    });
                }
            }
        } catch (error) {
            alert('Failed to start processing: ' + error);
            this.els.startBtn.disabled = false;
            this.els.processingStatus.classList.add('hidden');
        }
    }

    setAnalysisMode(isActive) {
        if (isActive) {
            // Hide Setup Canvas, Show Live Feed (which will be populated by processed video)
            this.els.canvas.style.display = 'none';
            this.els.liveFeed.classList.remove('hidden');
            this.els.liveBadge.classList.remove('hidden');
            this.els.modeLabel.textContent = "Live Analysis";
            
            // In a real app, you'd set the src of liveFeed to the processed stream URL
            // For now, we rely on the dashboard.js socket updates to handle data
        }
    }
    
    checkExistingSession() {
        // If the page loads and we already have a session, switch to analysis mode
        // (This relies on backend session logic or a global variable)
        const hasSession = document.getElementById('live-badge').classList.contains('active-session'); 
        if(hasSession) {
            this.setAnalysisMode(true);
        }
    }
}

// Global function for the HTML onclick attributes
function switchCameraContext(role) {
    if (window.workbenchManager) {
        window.workbenchManager.switchCameraContext(role);
    }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    // Initialize Dashboard (Analytics)
    window.dashboardManager = new DashboardManager();
    
    // Initialize Workbench (Setup/UI)
    window.workbenchManager = new WorkbenchManager();
});
