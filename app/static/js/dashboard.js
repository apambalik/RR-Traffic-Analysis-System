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
        // For "Continue Session" feature - accumulate stats instead of replacing
        this.continueMode = false;
        this.baselineStats = {
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
        if (this.continueMode) {
            // Accumulate: add new stats to baseline
            const baseline = this.baselineStats[role];
            this.cameraStats[role] = {
                vehicles_in: baseline.vehicles_in + (stats.vehicles_in || 0),
                vehicles_out: baseline.vehicles_out + (stats.vehicles_out || 0),
                net_vehicles: baseline.net_vehicles + (stats.net_vehicles || 0),
                people_on_site_min: baseline.people_on_site_min + (stats.people_on_site_min || 0),
                people_on_site_max: baseline.people_on_site_max + (stats.people_on_site_max || 0),
                vehicle_distribution: this.mergeDistributions(baseline.vehicle_distribution, stats.vehicle_distribution || {})
            };
        } else {
            this.cameraStats[role] = stats;
        }
        this.refreshDashboard();
    }
    
    // Merge two vehicle distribution objects by adding counts
    mergeDistributions(base, added) {
        const result = { ...base };
        for (const type in added) {
            result[type] = (result[type] || 0) + added[type];
        }
        return result;
    }
    
    // Enable continue mode - saves current stats as baseline
    setContinueMode(enabled) {
        this.continueMode = enabled;
        if (enabled) {
            // Save current stats as baseline to accumulate from
            this.baselineStats = {
                'ENTRY': JSON.parse(JSON.stringify(this.cameraStats.ENTRY)),
                'EXIT': JSON.parse(JSON.stringify(this.cameraStats.EXIT))
            };
            console.log('Continue mode enabled. Baseline stats saved:', this.baselineStats);
        } else {
            // Reset baseline
            this.baselineStats = {
                'ENTRY': this.createEmptyStats(),
                'EXIT': this.createEmptyStats()
            };
        }
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
            totalDist[type] = (entry.vehicle_distribution[type] || 0) - 
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
    // updateProcessingStatus(data) {
    //     // Implementation moved to WorkbenchManager for specific handling
    // }
    
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
        const vehicleClass = `badge-${event.vehicle_type.toLowerCase()}`;
        row.innerHTML = `
            <td>${timestamp}</td>
            <td><span class="badge ${vehicleClass}">${event.vehicle_type}</span></td>            
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
        if (data.statistics && data.camera_role) {
            // Update per-camera stats and aggregate (same as during processing)
            this.updateCameraStatistics(data.camera_role, data.statistics);
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
        this.sessionCompleted = false;  // Track if previous analysis finished (for hybrid session)
        
        // Track LineDrawer instances for BOTH cameras
        this.lineDrawers = {
            'ENTRY': null,
            'EXIT': null
        };
        
        // Track camera configurations separately
        this.cameraConfigs = {
            'ENTRY': { hasVideo: false, hasLine: false, videoName: '', processingStatus: 'pending', progress: 0 },
            'EXIT': { hasVideo: false, hasLine: false, videoName: '', processingStatus: 'pending', progress: 0 }
        };

        // Camera-specific elements
        this.cameraEls = {
            'ENTRY': {
                canvas: document.getElementById('entry-canvas'),
                placeholder: document.getElementById('entry-placeholder'),
                liveFeed: document.getElementById('entry-live-feed'),
                statusText: document.getElementById('entry-camera-status'),
                card: document.getElementById('entry-camera-card'),
                progressBar: document.getElementById('entry-progress-bar'),
                progressText: document.getElementById('entry-progress-text')
            },
            'EXIT': {
                canvas: document.getElementById('exit-canvas'),
                placeholder: document.getElementById('exit-placeholder'),
                liveFeed: document.getElementById('exit-live-feed'),
                statusText: document.getElementById('exit-camera-status'),
                card: document.getElementById('exit-camera-card'),
                progressBar: document.getElementById('exit-progress-bar'),
                progressText: document.getElementById('exit-progress-text')
            }
        };

        // Global elements
        this.els = {
            videoUpload: document.getElementById('video-upload'),
            fileName: document.getElementById('file-name-display'),
            startBtn: document.getElementById('btn-start-analysis'),
            clearLineBtn: document.getElementById('clear-line-btn'),
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
        this.updateStartButtonState();
        this.highlightSelectedCamera();
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

    highlightSelectedCamera() {
        // Highlight the currently selected camera card
        Object.keys(this.cameraEls).forEach(role => {
            const card = this.cameraEls[role].card;
            if (card) {
                if (role === this.currentCameraRole) {
                    card.classList.add('active');
                } else {
                    card.classList.remove('active');
                }
            }
        });
    }

    switchCameraContext(role) {
        this.currentCameraRole = role;
        
        // UI Updates for Tabs
        document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
        const activeId = role === 'ENTRY' ? 'tab-entry' : 'tab-exit';
        document.getElementById(activeId).classList.add('active');

        // Highlight camera card
        this.highlightSelectedCamera();

        // Update file name display for selected camera
        const config = this.cameraConfigs[role];
        if (config.videoName) {
            this.els.fileName.textContent = config.videoName;
        } else {
            this.els.fileName.textContent = 'No file selected';
        }
        
        // Update sidebar status based on current camera
        this.updateSidebarStatus();
        
        // Enable/disable clear button based on current camera
        this.els.clearLineBtn.disabled = !config.hasLine;
    }
    
    updateSidebarStatus() {
        const config = this.cameraConfigs[this.currentCameraRole];
        
        if (config.processingStatus === 'processing') {
            this.els.configStatusText.textContent = "Processing...";
            this.els.configStatusDot.className = "status-dot processing";
        } else if (config.processingStatus === 'completed') {
            this.els.configStatusText.textContent = "Analysis Complete";
            this.els.configStatusDot.className = "status-dot ready";
        } else if (config.hasLine) {
            this.els.configStatusText.textContent = "Ready";
            this.els.configStatusDot.className = "status-dot ready";
        } else if (config.hasVideo) {
            this.els.configStatusText.textContent = "Draw counting line";
            this.els.configStatusDot.className = "status-dot warning";
        } else {
            this.els.configStatusText.textContent = "Upload video";
            this.els.configStatusDot.className = "status-dot error";
        }
    }
    
    // Handle processing updates from socket
    handleProcessingUpdate(data) {
        if (!data.camera_role) return;
        
        const config = this.cameraConfigs[data.camera_role];
        const camEls = this.cameraEls[data.camera_role];
        
        if (config) {
            config.processingStatus = data.status;
            if (data.progress !== undefined) config.progress = data.progress;
            
            // Update camera status text
            this.updateCameraStatusText(data.camera_role);
            
            // Update progress bar for this camera
            this.updateCameraProgress(data.camera_role);
            
            // Update sidebar if this is the selected camera
            if (this.currentCameraRole === data.camera_role) {
                this.updateSidebarStatus();
            }
            
            // Check if both are completed
            this.checkAllCompleted();
        }
    }

    handleProgressUpdate(data) {
        if (!data.camera_role) return;
        
        const config = this.cameraConfigs[data.camera_role];
        if (config) {
            config.progress = data.progress;
            if (config.processingStatus === 'pending') {
                config.processingStatus = 'processing';
            }
            
            this.updateCameraProgress(data.camera_role);
            this.updateCameraStatusText(data.camera_role);
            
            if (this.currentCameraRole === data.camera_role) {
                this.updateSidebarStatus();
            }
        }
    }
    
    updateCameraStatusText(role) {
        const config = this.cameraConfigs[role];
        const statusEl = this.cameraEls[role].statusText;
        
        if (!statusEl) return;
        
        if (config.processingStatus === 'processing') {
            statusEl.textContent = `Processing ${config.progress}%`;
            statusEl.className = 'camera-status processing';
        } else if (config.processingStatus === 'completed') {
            statusEl.textContent = 'Completed';
            statusEl.className = 'camera-status completed';
        } else if (config.hasLine) {
            statusEl.textContent = 'Ready';
            statusEl.className = 'camera-status ready';
        } else if (config.hasVideo) {
            statusEl.textContent = 'Draw Line';
            statusEl.className = 'camera-status';
        } else {
            statusEl.textContent = 'Not Configured';
            statusEl.className = 'camera-status';
        }
    }
    
    updateCameraProgress(role) {
        const config = this.cameraConfigs[role];
        const progressBar = this.cameraEls[role].progressBar;
        const progressText = this.cameraEls[role].progressText;
        
        if (progressBar) {
            progressBar.style.width = `${config.progress || 0}%`;
        }
        if (progressText) {
            progressText.textContent = `${config.progress || 0}%`;
        }
    }
    
    checkAllCompleted() {
        const entryDone = this.cameraConfigs.ENTRY.processingStatus === 'completed';
        const exitDone = this.cameraConfigs.EXIT.processingStatus === 'completed';
        
        if (entryDone && exitDone) {
            this.sessionCompleted = true;  // Mark session as completed for hybrid approach
            
            // Disable continue mode now that processing is done
            if (window.dashboardManager) {
                window.dashboardManager.setContinueMode(false);
            }
            
            this.els.startBtn.innerHTML = `<i data-feather="check"></i> Analysis Complete`;
            this.els.startBtn.disabled = true;
            this.els.processingStatus.classList.add('hidden');
            feather.replace();
        }
    }

    async handleVideoUpload(e) {
        if (!e.target.files || !e.target.files.length) return;
        const file = e.target.files[0];
        
        // Check if previous session completed - show choice modal
        if (this.sessionCompleted) {
            const choice = await this.showSessionChoiceModal();
            if (choice === 'new') {
                this.resetSession();
                // Disable continue mode (stats will be replaced)
                if (window.dashboardManager) {
                    window.dashboardManager.setContinueMode(false);
                }
            } else {
                // Enable continue mode - accumulate new stats on top of existing
                if (window.dashboardManager) {
                    window.dashboardManager.setContinueMode(true);
                }
            }
            this.sessionCompleted = false;
        }
        
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
                
                // Load frame into the correct camera canvas
                await this.loadFirstFrame(this.currentCameraRole);
                
                // Update start button state
                this.updateStartButtonState();
            } else {
                alert('Upload failed: ' + data.error);
            }
        } catch (error) {
            alert('Error uploading video: ' + error.message);
        }
    }
    
    /**
     * Show modal asking user whether to continue session or start fresh
     * @returns {Promise<string>} 'continue' or 'new'
     */
    showSessionChoiceModal() {
        return new Promise((resolve) => {
            const modal = document.getElementById('session-choice-modal');
            const continueBtn = document.getElementById('btn-continue-session');
            const newBtn = document.getElementById('btn-new-session');
            
            // Show modal
            modal.classList.remove('hidden');
            feather.replace();
            
            // Handle button clicks
            const handleContinue = () => {
                modal.classList.add('hidden');
                cleanup();
                resolve('continue');
            };
            
            const handleNew = () => {
                modal.classList.add('hidden');
                cleanup();
                resolve('new');
            };
            
            const cleanup = () => {
                continueBtn.removeEventListener('click', handleContinue);
                newBtn.removeEventListener('click', handleNew);
            };
            
            continueBtn.addEventListener('click', handleContinue);
            newBtn.addEventListener('click', handleNew);
        });
    }
    
    /**
     * Reset all session data for a fresh start
     */
    resetSession() {
        console.log('Resetting session...');
        
        // Reset dashboard manager stats
        if (window.dashboardManager) {
            window.dashboardManager.cameraStats = {
                'ENTRY': window.dashboardManager.createEmptyStats(),
                'EXIT': window.dashboardManager.createEmptyStats()
            };
            window.dashboardManager.eventCount = 0;
            window.dashboardManager.refreshDashboard();
            
            // Reset distribution chart
            if (window.dashboardManager.charts.distribution) {
                window.dashboardManager.charts.distribution.data.datasets[0].data = [0, 0, 0, 0, 0, 0, 0];
                window.dashboardManager.charts.distribution.update('none');
            }
        }
        
        // Clear event log
        const tbody = document.getElementById('event-log-body');
        if (tbody) {
            tbody.innerHTML = '<tr class="empty-row"><td colspan="4" class="text-center text-secondary">No events yet</td></tr>';
        }
        
        // Reset event count badge
        const eventCount = document.getElementById('event-count');
        if (eventCount) {
            eventCount.textContent = '0 events';
        }
        
        // Reset camera configs processing status
        this.cameraConfigs.ENTRY.processingStatus = 'pending';
        this.cameraConfigs.ENTRY.progress = 0;
        this.cameraConfigs.ENTRY.hasVideo = false;
        this.cameraConfigs.ENTRY.hasLine = false;
        this.cameraConfigs.ENTRY.videoName = '';
        
        this.cameraConfigs.EXIT.processingStatus = 'pending';
        this.cameraConfigs.EXIT.progress = 0;
        this.cameraConfigs.EXIT.hasVideo = false;
        this.cameraConfigs.EXIT.hasLine = false;
        this.cameraConfigs.EXIT.videoName = '';
        
        // Reset line drawers
        this.lineDrawers.ENTRY = null;
        this.lineDrawers.EXIT = null;
        
        // Reset camera UI elements
        ['ENTRY', 'EXIT'].forEach(role => {
            const camEls = this.cameraEls[role];
            if (camEls.canvas) camEls.canvas.style.display = 'none';
            if (camEls.placeholder) camEls.placeholder.style.display = 'block';
            if (camEls.liveFeed) {
                camEls.liveFeed.style.display = 'none';
                camEls.liveFeed.src = '';
            }
            if (camEls.progressBar) camEls.progressBar.style.width = '0%';
            if (camEls.progressText) camEls.progressText.textContent = '0%';
            this.updateCameraStatusText(role);
        });
        
        // Reset global UI elements
        this.els.startBtn.innerHTML = `<i data-feather="play"></i> Start Analysis`;
        this.els.startBtn.disabled = true;
        this.els.processingStatus.classList.add('hidden');
        this.els.liveBadge.classList.add('hidden');
        this.els.modeLabel.textContent = 'Setup';
        this.els.fileName.textContent = 'No file selected';
        this.els.clearLineBtn.disabled = true;
        
        this.updateSidebarStatus();
        feather.replace();
        
        console.log('Session reset complete');
    }

    async loadFirstFrame(role) {
        const camEls = this.cameraEls[role];
        const config = this.cameraConfigs[role];
        
        try {
            const response = await fetch(`/setup/get-first-frame?camera_role=${role}`);
            const data = await response.json();

            if (data.frame) {
                // Hide placeholder, show canvas
                if (camEls.placeholder) camEls.placeholder.style.display = 'none';
                if (camEls.canvas) camEls.canvas.style.display = 'block';
                if (camEls.liveFeed) camEls.liveFeed.classList.add('hidden');

                // Create LineDrawer for this camera
                const canvasId = role === 'ENTRY' ? 'entry-canvas' : 'exit-canvas';
                this.lineDrawers[role] = new LineDrawer(canvasId);
                await this.lineDrawers[role].loadImage('data:image/jpeg;base64,' + data.frame);

                // Restore line if it exists
                if (data.line_points) {
                    this.lineDrawers[role].setLinePoints(data.line_points);
                    config.hasLine = true;
                    this.updateCameraStatusText(role);
                    this.updateStartButtonState();
                }
                
                // Attach callback for when line is drawn
                this.lineDrawers[role].onLineComplete = (points) => {
                    config.hasLine = true;
                    this.updateCameraStatusText(role);
                    this.updateStartButtonState();
                    
                    // Auto-save line
                    this.saveLine(role, points);
                    
                    // Update sidebar if this is selected camera
                    if (this.currentCameraRole === role) {
                        this.els.clearLineBtn.disabled = false;
                        this.updateSidebarStatus();
                    }
                };
                
                // Update camera status
                this.updateCameraStatusText(role);
            }
        } catch (error) {
            console.error(`Error loading frame for ${role}:`, error);
        }
    }
    
    async saveLine(role, points) {
        try {
            await fetch('/setup/save-line', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    line_points: points,
                    camera_role: role
                })
            });
            console.log(`Line auto-saved for ${role}`);
        } catch (e) {
            console.error(`Failed to auto-save line for ${role}`, e);
        }
    }

    resetLine() {
        const role = this.currentCameraRole;
        const lineDrawer = this.lineDrawers[role];
        
        if (lineDrawer) {
            lineDrawer.reset();
            this.cameraConfigs[role].hasLine = false;
            this.updateCameraStatusText(role);
            this.updateStartButtonState();
            this.updateSidebarStatus();
            this.els.clearLineBtn.disabled = true;
        }
    }

    updateStartButtonState() {
        // Both cameras must have video AND line to enable start
        const entryReady = this.cameraConfigs.ENTRY.hasVideo && this.cameraConfigs.ENTRY.hasLine;
        const exitReady = this.cameraConfigs.EXIT.hasVideo && this.cameraConfigs.EXIT.hasLine;
        const anyProcessing = this.cameraConfigs.ENTRY.processingStatus === 'processing' || 
                             this.cameraConfigs.EXIT.processingStatus === 'processing';
        
        if (anyProcessing) {
            this.els.startBtn.disabled = true;
        } else if (entryReady && exitReady) {
            this.els.startBtn.disabled = false;
            this.els.startBtn.innerHTML = `<i data-feather="play"></i> Start Analysis`;
            feather.replace();
        } else {
            this.els.startBtn.disabled = true;
        }
    }

    async startAnalysis() {
        const entryConfig = this.cameraConfigs.ENTRY;
        const exitConfig = this.cameraConfigs.EXIT;
        
        // Validate both cameras are configured
        if (!entryConfig.hasVideo || !entryConfig.hasLine) {
            alert("Please configure the Entry camera first (upload video and draw line).");
            return;
        }
        if (!exitConfig.hasVideo || !exitConfig.hasLine) {
            alert("Please configure the Exit camera first (upload video and draw line).");
            return;
        }

        // Show processing UI
        this.els.processingStatus.classList.remove('hidden');
        this.els.startBtn.disabled = true;
        this.els.startBtn.innerHTML = `<i data-feather="loader" class="spin"></i> Processing...`;
        feather.replace();
        
        const location = this.els.locationInput.value || 'Unknown';
        let sessionId = null;

        try {
            // Start Entry camera processing
            const entryResponse = await fetch('/setup/start-processing', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    location: location,
                    camera_role: 'ENTRY'
                })
            });
            const entryData = await entryResponse.json();

            if (entryData.success) {
                sessionId = entryData.session_id;
                entryConfig.processingStatus = 'processing';
                this.updateCameraStatusText('ENTRY');
                // Start live stream for Entry camera
                this.setAnalysisMode(true, 'ENTRY');
            } else {
                throw new Error(`Entry camera: ${entryData.error}`);
            }

            // Start Exit camera processing
            const exitResponse = await fetch('/setup/start-processing', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    location: location,
                    camera_role: 'EXIT'
                })
            });
            const exitData = await exitResponse.json();

            if (exitData.success) {
                exitConfig.processingStatus = 'processing';
                this.updateCameraStatusText('EXIT');
                // Start live stream for Exit camera
                this.setAnalysisMode(true, 'EXIT');
            } else {
                throw new Error(`Exit camera: ${exitData.error}`);
            }
            
            // Join socket room for real-time updates
            if (window.dashboardManager && window.dashboardManager.socket && sessionId) {
                window.dashboardManager.sessionId = sessionId;
                window.dashboardManager.socket.emit('join_session', { 
                    session_id: sessionId 
                });
            }
            
        } catch (error) {
            alert('Failed to start processing: ' + error.message);
            this.els.startBtn.disabled = false;
            this.els.startBtn.innerHTML = `<i data-feather="play"></i> Start Analysis`;
            this.els.processingStatus.classList.add('hidden');
            feather.replace();
        }
    }

    setAnalysisMode(isActive, cameraRole) {
        if (isActive) {
            console.log(`Setting analysis mode for ${cameraRole} camera`);
            
            // Get the live feed element for this camera
            const liveFeedId = cameraRole === 'ENTRY' ? 'entry-live-feed' : 'exit-live-feed';
            const liveFeed = document.getElementById(liveFeedId);
            
            // Get the setup canvas for this camera
            const canvasId = cameraRole === 'ENTRY' ? 'entry-canvas' : 'exit-canvas';
            const canvas = document.getElementById(canvasId);
            
            // Hide canvas, show live feed
            if (canvas) {
                canvas.style.display = 'none';
                console.log(`Hidden ${canvasId} canvas`);
            }
            
            if (liveFeed) {
                liveFeed.style.display = 'block';
                liveFeed.classList.remove('hidden');
                // Start streaming from backend MJPEG endpoint
                const streamUrl = `/video-feed/${cameraRole}`;
                liveFeed.src = streamUrl;
                console.log(`Started live stream: ${streamUrl}`);
            } else {
                console.error(`Live feed element not found: ${liveFeedId}`);
            }
            
            this.els.liveBadge.classList.remove('hidden');
            this.els.modeLabel.textContent = "Live Analysis";
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