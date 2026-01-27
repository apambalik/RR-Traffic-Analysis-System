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
        this.cameraStats = {
            'ENTRY': this.createEmptyStats(),
            'EXIT': this.createEmptyStats()
        };
        this.init();
    }

    createEmptyStats() {
        return {
            vehicles_in: 0,
            vehicles_out: 0,
            net_vehicles: 0,
            people_on_site_min: 0,
            people_on_site_max: 0,
            vehicle_distribution: {}
        };
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
            if (this.sessionId) this.socket.emit('join_session', { session_id: this.sessionId });
        });

        this.socket.on('processing_status', (data) => {
            if (window.workbenchManager) window.workbenchManager.handleProcessingUpdate(data);
        });
        
        this.socket.on('processing_progress', (data) => {
            if (window.workbenchManager) window.workbenchManager.handleProgressUpdate(data);
        });
        
        this.socket.on('vehicle_event', (data) => {
            this.addEventToLog(data.event);
        });
        
        // CHANGED: Handle statistics per camera
        this.socket.on('statistics_update', (data) => {
            if (data.camera_role) {
                this.updateCameraStatistics(data.camera_role, data.statistics);
            } else {
                // Fallback for initial load or legacy events
                this.updateAggregatedStatistics(data.statistics);
            }
        });
        
        this.socket.on('processing_complete', (data) => {
            this.onProcessingComplete(data);
            if (window.workbenchManager) {
                window.workbenchManager.handleProcessingUpdate({
                    camera_role: data.camera_role,
                    status: 'completed',
                    progress: 100
                });
            }
        });
        
        this.socket.on('processing_error', (data) => {
            console.error('Processing error:', data.error);
            this.onProcessingError(data.error);
             if (window.workbenchManager) {
                window.workbenchManager.handleProcessingUpdate({
                    camera_role: data.camera_role,
                    status: 'error',
                    progress: 0
                });
            }
        });
    }
    
    // Update stats for a specific camera and then refresh display
    updateCameraStatistics(role, stats) {
        this.cameraStats[role] = stats;
        this.refreshDashboard();
    }

    // Calculate totals and update UI
    refreshDashboard() {
        const entry = this.cameraStats.ENTRY;
        const exit = this.cameraStats.EXIT;
        
        // Sum distribution
        const totalDist = {};
        const allTypes = new Set([
            ...Object.keys(entry.vehicle_distribution || {}), 
            ...Object.keys(exit.vehicle_distribution || {})
        ]);
        
        allTypes.forEach(type => {
            totalDist[type] = (entry.vehicle_distribution[type] || 0) + 
                            (exit.vehicle_distribution[type] || 0);
        });

        const aggregated = {
            vehicles_in: (entry.vehicles_in || 0) + (exit.vehicles_in || 0),
            vehicles_out: (entry.vehicles_out || 0) + (exit.vehicles_out || 0),
            net_vehicles: (entry.net_vehicles || 0) + (exit.net_vehicles || 0),
            people_on_site_min: (entry.people_on_site_min || 0) + (exit.people_on_site_min || 0),
            people_on_site_max: (entry.people_on_site_max || 0) + (exit.people_on_site_max || 0),
            vehicle_distribution: totalDist
        };
        
        this.updateAggregatedStatistics(aggregated);
    }    
    
    async fetchInitialData() {
        try {
            const statsResponse = await fetch('/api/statistics');
            if (statsResponse.ok) {
                const stats = await statsResponse.json();
                // Initial load is likely the total from DB, so we display it directly
                // Note: Real-time updates will takeover shortly
                this.updateAggregatedStatistics(stats);
            }
            // ... events fetch ...
        } catch (error) {
            console.error(error);
        }
    }
    
    // Legacy support or global banner
    updateProcessingStatus(data) {
        // Implementation moved to WorkbenchManager for specific handling
    }
    
    updateAggregatedStatistics(stats) {
        const vehiclesIn = document.getElementById('vehicles-in');
        const vehiclesOut = document.getElementById('vehicles-out');
        const netVehicles = document.getElementById('net-vehicles');
        const peopleRange = document.getElementById('people-range');
        
        if (vehiclesIn) vehiclesIn.textContent = stats.vehicles_in || 0;
        if (vehiclesOut) vehiclesOut.textContent = stats.vehicles_out || 0;
        if (netVehicles) netVehicles.textContent = stats.net_vehicles || 0;
        
        if (peopleRange) {
            peopleRange.textContent = `${stats.people_on_site_min} - ${stats.people_on_site_max}`;
        }
        
        if (stats.vehicle_distribution) {
            this.updateDistributionChart(stats.vehicle_distribution);
        }
    }
    
    addEventToLog(event) {
        const tbody = document.getElementById('event-log-body');
        if (!tbody) return;
        
        const emptyRow = tbody.querySelector('.empty-row');
        if (emptyRow) {
            emptyRow.remove();
        }
        
        const row = document.createElement('tr');
        row.className = 'new-event';
        
        let timestamp = '--:--:--';
        if (event.timestamp) {
            const ts = event.timestamp;
            if (ts.includes('T')) {
                timestamp = ts.split('T')[1].substring(0, 8);
            } else if (ts.length >= 8) {
                timestamp = ts.substring(ts.length - 8);
            }
        }
        
        const directionClass = event.direction === 'IN' ? 'badge-in' : 'badge-out';
        
        row.innerHTML = `
            <td>${timestamp}</td>
            <td><span class="badge badge-${event.vehicle_type.toLowerCase()}">${event.vehicle_type}</span></td>
            <td><span class="badge ${directionClass}">${event.direction}</span></td>
            <td>${event.seats_min} - ${event.seats_max}</td>
        `;
        
        tbody.insertBefore(row, tbody.firstChild);
        
        while (tbody.children.length > this.maxLogEvents) {
            tbody.removeChild(tbody.lastChild);
        }
        
        this.eventCount++;
        document.getElementById('event-count').textContent = `${this.eventCount} events`;
        
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
        this.showNotification('Processing Complete', 'Video analysis finished successfully!', 'success');
        if (data.statistics) {
            this.updateStatistics(data.statistics);
            if (data.statistics.vehicle_distribution) {
                this.updateDistributionChart(data.statistics.vehicle_distribution);
            }
        }
    }
    
    onProcessingError(error) {
        this.showNotification('Processing Error', error, 'error');
    }
    
    showNotification(title, message, type = 'info') {
        const notification = document.createElement('div');
        notification.className = `notification notification-${type}`;
        notification.innerHTML = `
            <strong>${title}</strong>
            <p>${message}</p>
        `;
        
        document.body.appendChild(notification);
        setTimeout(() => {
            notification.classList.add('fade-out');
            setTimeout(() => notification.remove(), 300);
        }, 5000);
    }
    
    setupCharts() {
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
                    plugins: { legend: { display: false } },
                    scales: {
                        y: { beginAtZero: true, grid: { color: '#e2e8f0' } },
                        x: { grid: { display: false } }
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
            });
        });
    }
}

class WorkbenchManager {
    constructor() {
        // State
        this.currentCameraRole = 'ENTRY';
        this.lineDrawer = null;
        this.isConfigured = false;
        this.lineSet = false;
        
        // Track camera configurations separately
        this.cameraConfigs = {
            'ENTRY': { hasVideo: false, hasLine: false, videoName: '', processingStatus: 'pending', progress: 0 },
            'EXIT': { hasVideo: false, hasLine: false, videoName: '', processingStatus: 'pending', progress: 0 }
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
            liveBadge: document.getElementById('live-badge'),
            progressBar: document.getElementById('progress-bar'),
            processingText: document.getElementById('processing-text')
        };

        this.init();
    }

    init() {
        this.setupEventListeners();
        this.checkExistingSession();
    }

    setupEventListeners() {
        if (this.els.videoUpload) {
            this.els.videoUpload.addEventListener('change', (e) => this.handleVideoUpload(e));
        }
        if (this.els.clearLineBtn) {
            this.els.clearLineBtn.addEventListener('click', () => this.resetLine());
        }
        if (this.els.startBtn) {
            this.els.startBtn.addEventListener('click', () => this.startAnalysis());
        }
    }

    switchCameraContext(role) {
        this.currentCameraRole = role;
        
        // UI Updates for Tabs
        document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
        const activeId = role === 'ENTRY' ? 'tab-entry' : 'tab-exit';
        document.getElementById(activeId).classList.add('active');
        
        document.getElementById('stage-label').textContent = 
            `${role.charAt(0).toUpperCase() + role.slice(1).toLowerCase()} Camera Preview`;

        const config = this.cameraConfigs[role];
        if (config.videoName) {
            this.els.fileName.textContent = config.videoName;
        } else {
            this.els.fileName.textContent = 'No file selected';
        }
        
        if (config.hasVideo) {
            this.loadFirstFrame();
            this.updateConfigStatus(config.hasLine);
            if (config.hasLine) {
                this.els.clearLineBtn.disabled = false;
            }
        } else {
            this.els.canvas.style.display = 'none';
            this.els.placeholder.style.display = 'block';
            this.updateConfigStatus(false);
            this.els.clearLineBtn.disabled = true;
        }

        // Update action panel UI to reflect status of THIS camera
        this.updateActionPanelUI();
    }
    
    // NEW: Handle processing updates from socket
    handleProcessingUpdate(data) {
        if (!data.camera_role) return;
        
        const config = this.cameraConfigs[data.camera_role];
        if (config) {
            config.processingStatus = data.status;
            if (data.progress) config.progress = data.progress;
            
            if (this.currentCameraRole === data.camera_role) {
                this.updateActionPanelUI();
            }
        }
    }

    handleProgressUpdate(data) {
        if (!data.camera_role) return;
        
        const config = this.cameraConfigs[data.camera_role];
        if (config) {
            config.progress = data.progress;
            if (config.processingStatus === 'pending') config.processingStatus = 'processing';
            
            if (this.currentCameraRole === data.camera_role) {
                this.updateActionPanelUI();
            }
        }
    }

    updateActionPanelUI() {
        const config = this.cameraConfigs[this.currentCameraRole];
        const status = config.processingStatus;
        
        if (status === 'processing') {
             this.els.processingStatus.classList.remove('hidden');
             this.els.startBtn.disabled = true;
             this.els.startBtn.innerHTML = `<i data-feather="loader" class="spin"></i> Processing...`;
             
             if (this.els.progressBar) {
                 this.els.progressBar.style.width = (config.progress || 0) + '%';
             }
             if (this.els.processingText) {
                 this.els.processingText.textContent = `Processing... ${config.progress || 0}%`;
             }
             feather.replace();
        } else if (status === 'completed') {
             this.els.processingStatus.classList.add('hidden');
             this.els.startBtn.disabled = true;
             this.els.startBtn.innerHTML = `<i data-feather="check"></i> Completed`;
             this.els.configStatusText.textContent = "Analysis Complete";
             this.els.configStatusDot.className = "status-dot ready";
             feather.replace();
        } else {
             // Pending or reset
             this.els.processingStatus.classList.add('hidden');
             this.els.startBtn.innerHTML = `<i data-feather="play"></i> Start Analysis`;
             this.updateConfigStatus(config.hasLine); // Re-enable if ready
             feather.replace();
        }
    }

    async handleVideoUpload(e) {
        if (!e.target.files || !e.target.files.length) return;
        const file = e.target.files[0];
        this.els.fileName.textContent = file.name;
        
        const formData = new FormData();
        formData.append('video', file);
        formData.append('camera_role', this.currentCameraRole);

        try {
            const response = await fetch('/setup/upload-video', {
                method: 'POST',
                body: formData
            });
            const data = await response.json();

            if (data.success) {
                this.cameraConfigs[this.currentCameraRole].hasVideo = true;
                this.cameraConfigs[this.currentCameraRole].videoName = file.name;
                this.loadFirstFrame();
            } else {
                alert('Upload failed: ' + data.error);
            }
        } catch (error) {
            alert('Error uploading video: ' + error.message);
        }
    }

    async loadFirstFrame() {
        try {
            const response = await fetch(`/setup/get-first-frame?camera_role=${this.currentCameraRole}`);
            const data = await response.json();

            if (data.frame) {
                this.els.placeholder.style.display = 'none';
                this.els.canvas.style.display = 'block';
                this.els.liveFeed.classList.add('hidden');

                this.lineDrawer = new LineDrawer('setup-canvas');
                await this.lineDrawer.loadImage('data:image/jpeg;base64,' + data.frame);

                if (data.line_points) {
                    this.lineDrawer.setLinePoints(data.line_points);
                    this.lineSet = true;
                    this.cameraConfigs[this.currentCameraRole].hasLine = true;
                    this.els.clearLineBtn.disabled = false;
                    this.updateConfigStatus(true);
                }
                
                // NEW: Attach Callback with Auto-Save
                this.lineDrawer.onLineComplete = (points) => {
                    this.lineSet = true;
                    this.cameraConfigs[this.currentCameraRole].hasLine = true;
                    this.els.clearLineBtn.disabled = false;
                    this.updateConfigStatus(true);
                    
                    // FIX: Automatically save line to backend
                    this.saveLine(points);
                };
            }
        } catch (error) {
            console.error('Error loading frame:', error);
        }
    }
    
    // Helper to auto-save
    async saveLine(points) {
        try {
            await fetch('/setup/save-line', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    line_points: points,
                    camera_role: this.currentCameraRole
                })
            });
            console.log('Line auto-saved');
        } catch (e) {
            console.error('Failed to auto-save line', e);
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

    async startAnalysis() {
        if (!this.lineSet || !this.lineDrawer) {
            alert("Please draw the counting line first.");
            return;
        }

        // Line is already auto-saved, but we can double check or just proceed
        
        this.els.processingStatus.classList.remove('hidden');
        this.els.startBtn.disabled = true;
        
        const location = this.els.locationInput.value || 'Unknown';

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
                // Update local state
                const config = this.cameraConfigs[this.currentCameraRole];
                config.processingStatus = 'processing';
                this.updateActionPanelUI();

                this.setAnalysisMode(true);
                
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
            this.els.canvas.style.display = 'none';
            this.els.liveFeed.classList.remove('hidden');
            this.els.liveBadge.classList.remove('hidden');
            this.els.modeLabel.textContent = "Live Analysis";
        }
    }
    
    checkExistingSession() {
        // Simple check
        const hasSession = document.getElementById('live-badge').classList.contains('active-session'); 
        if(hasSession) {
            this.setAnalysisMode(true);
        }
    }
}

function switchCameraContext(role) {
    if (window.workbenchManager) {
        window.workbenchManager.switchCameraContext(role);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.dashboardManager = new DashboardManager();
    window.workbenchManager = new WorkbenchManager();
});