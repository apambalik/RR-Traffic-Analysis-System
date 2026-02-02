/**
 * R&R Traffic Analysis System - Dashboard Module
 * 
 * This module handles real-time analytics display and camera workbench management.
 * It manages WebSocket connections for live updates and provides UI controls for
 * video processing configuration.
 */

// =============================================================================
// CONSTANTS & CONFIGURATION
// =============================================================================

const CAMERA_ROLES = Object.freeze({
    ENTRY: 'ENTRY',
    EXIT: 'EXIT'
});

const PROCESSING_STATUS = Object.freeze({
    PENDING: 'pending',
    PROCESSING: 'processing',
    COMPLETED: 'completed',
    STOPPED: 'stopped',
    ERROR: 'error'
});

const SOURCE_TYPE = Object.freeze({
    FILE: 'file',
    STREAM: 'stream'
});

const CONFIG = Object.freeze({
    MAX_LOG_EVENTS: 50,
    NOTIFICATION_DURATION_MS: 5000,
    NEW_EVENT_HIGHLIGHT_MS: 1000,
    DEFAULT_CHART_DATA: [0, 0, 0, 0, 0, 0, 0],
    VEHICLE_TYPES: ['Sedan', 'SUV', 'Pickup', 'Motorcycle', 'Van', 'Truck', 'Bus']
});

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Creates a deep clone of an object
 * @param {Object} obj - Object to clone
 * @returns {Object} Deep cloned object
 */
const deepClone = (obj) => JSON.parse(JSON.stringify(obj));

/**
 * Safely gets a DOM element by ID with optional warning
 * @param {string} id - Element ID
 * @param {boolean} warn - Whether to warn if not found
 * @returns {HTMLElement|null}
 */
const getElement = (id, warn = false) => {
    const el = document.getElementById(id);
    if (!el && warn) console.warn(`Element not found: ${id}`);
    return el;
};

/**
 * Formats a timestamp string for display
 * @param {string} timestamp - ISO timestamp or time string
 * @returns {string} Formatted time (HH:MM:SS)
 */
const formatTimestamp = (timestamp) => {
    if (!timestamp) return '--:--:--';
    if (timestamp.includes('T')) {
        return timestamp.split('T')[1].substring(0, 8);
    }
    return timestamp.length >= 8 ? timestamp.substring(timestamp.length - 8) : timestamp;
};

/**
 * Creates an empty statistics object
 * @returns {Object} Empty stats structure
 */
const createEmptyStats = () => ({
    vehicles_in: 0,
    vehicles_out: 0,
    net_vehicles: 0,
    people_on_site_min: 0,
    people_on_site_max: 0,
    vehicle_distribution: {}
});

/**
 * Creates initial camera configuration
 * @returns {Object} Default camera config
 */
const createCameraConfig = () => ({
    hasVideo: false,
    hasLine: false,
    videoName: '',
    processingStatus: PROCESSING_STATUS.PENDING,
    progress: 0,
    isLiveStream: false
});

/**
 * Merges two vehicle distribution objects by adding counts
 * @param {Object} base - Base distribution
 * @param {Object} added - Distribution to add
 * @returns {Object} Merged distribution
 */
const mergeDistributions = (base, added) => {
    const result = { ...base };
    for (const type in added) {
        result[type] = (result[type] || 0) + added[type];
    }
    return result;
};

/**
 * Accumulates statistics from new data onto a baseline
 * @param {Object} baseline - Base statistics
 * @param {Object} newStats - New statistics to add
 * @returns {Object} Accumulated statistics
 */
const accumulateStats = (baseline, newStats) => ({
    vehicles_in: baseline.vehicles_in + (newStats.vehicles_in || 0),
    vehicles_out: baseline.vehicles_out + (newStats.vehicles_out || 0),
    net_vehicles: baseline.net_vehicles + (newStats.net_vehicles || 0),
    people_on_site_min: baseline.people_on_site_min + (newStats.people_on_site_min || 0),
    people_on_site_max: baseline.people_on_site_max + (newStats.people_on_site_max || 0),
    vehicle_distribution: mergeDistributions(
        baseline.vehicle_distribution,
        newStats.vehicle_distribution || {}
    )
});

// =============================================================================
// DASHBOARD MANAGER
// =============================================================================

/**
 * Manages real-time dashboard updates via WebSocket
 * Handles statistics display, event logging, and chart updates
 */
class DashboardManager {
    constructor() {
        this.socket = null;
        this.sessionId = window.SESSION_ID || null;
        this.charts = {};
        this.eventCount = 0;

        // Per-camera statistics
        this.cameraStats = {
            [CAMERA_ROLES.ENTRY]: createEmptyStats(),
            [CAMERA_ROLES.EXIT]: createEmptyStats()
        };

        // Continue session feature - accumulate stats instead of replacing
        this.continueMode = false;
        this.baselineStats = {
            [CAMERA_ROLES.ENTRY]: createEmptyStats(),
            [CAMERA_ROLES.EXIT]: createEmptyStats()
        };

        // DOM element references
        this.elements = {
            vehiclesIn: getElement('vehicles-in'),
            vehiclesOut: getElement('vehicles-out'),
            netVehicles: getElement('net-vehicles'),
            peopleRange: getElement('people-range'),
            eventLogBody: getElement('event-log-body'),
            eventCount: getElement('event-count')
        };

        this.init();
    }

    init() {
        this.setupCharts();
        this.setupSocketIO();
        this.setupTimeFilter();

        if (this.sessionId) {
            this.fetchInitialData();
        }
    }

    // -------------------------------------------------------------------------
    // Socket.IO Setup & Handlers
    // -------------------------------------------------------------------------

    setupSocketIO() {
        this.socket = io();

        this.socket.on('connect', () => {
            console.log('Connected to server');
            if (this.sessionId) {
                this.socket.emit('join_session', { session_id: this.sessionId });
            }
        });

        // Route socket events to handlers
        this.socket.on('processing_status', (data) => this.forwardToWorkbench('handleProcessingUpdate', data));
        this.socket.on('processing_progress', (data) => this.forwardToWorkbench('handleProgressUpdate', data));
        this.socket.on('vehicle_event', (data) => this.handleVehicleEvent(data));
        this.socket.on('statistics_update', (data) => this.handleStatisticsUpdate(data));
        this.socket.on('processing_complete', (data) => this.handleProcessingComplete(data));
        this.socket.on('processing_error', (data) => this.handleProcessingError(data));
    }

    /**
     * Forwards data to WorkbenchManager if available
     */
    forwardToWorkbench(method, data) {
        if (window.workbenchManager && typeof window.workbenchManager[method] === 'function') {
            window.workbenchManager[method](data);
        }
    }

    handleVehicleEvent(data) {
        this.addEventToLog(data.event);
    }

    handleStatisticsUpdate(data) {
        if (data.camera_role) {
            this.updateCameraStatistics(data.camera_role, data.statistics);
        } else {
            this.updateDisplay(data.statistics);
        }
    }

    handleProcessingComplete(data) {
        this.showNotification('Processing Complete', 'Video analysis finished successfully!', 'success');
        
        if (data.statistics && data.camera_role) {
            this.updateCameraStatistics(data.camera_role, data.statistics);
        }

        this.forwardToWorkbench('handleProcessingUpdate', {
            camera_role: data.camera_role,
            status: PROCESSING_STATUS.COMPLETED,
            progress: 100
        });
    }

    handleProcessingError(data) {
        console.error('Processing error:', data.error);
        this.showNotification('Processing Error', data.error, 'error');
        
        this.forwardToWorkbench('handleProcessingUpdate', {
            camera_role: data.camera_role,
            status: PROCESSING_STATUS.ERROR,
            progress: 0
        });
    }

    // -------------------------------------------------------------------------
    // Statistics Management
    // -------------------------------------------------------------------------

    /**
     * Updates statistics for a specific camera and refreshes the display
     */
    updateCameraStatistics(role, stats) {
        if (this.continueMode) {
            // Accumulate new stats onto baseline
            this.cameraStats[role] = accumulateStats(this.baselineStats[role], stats);
        } else {
            this.cameraStats[role] = stats;
        }
        this.refreshDashboard();
    }

    /**
     * Enables/disables continue mode for accumulating statistics
     */
    setContinueMode(enabled) {
        this.continueMode = enabled;

        if (enabled) {
            // Save current stats as baseline
            this.baselineStats = {
                [CAMERA_ROLES.ENTRY]: deepClone(this.cameraStats[CAMERA_ROLES.ENTRY]),
                [CAMERA_ROLES.EXIT]: deepClone(this.cameraStats[CAMERA_ROLES.EXIT])
            };
            console.log('Continue mode enabled. Baseline stats saved.');
        } else {
            // Reset baseline
            this.baselineStats = {
                [CAMERA_ROLES.ENTRY]: createEmptyStats(),
                [CAMERA_ROLES.EXIT]: createEmptyStats()
            };
        }
    }

    /**
     * Aggregates camera stats and updates the UI
     */
    refreshDashboard() {
        const entry = this.cameraStats[CAMERA_ROLES.ENTRY];
        const exit = this.cameraStats[CAMERA_ROLES.EXIT];

        // Calculate net vehicle distribution (entry - exit)
        const allTypes = new Set([
            ...Object.keys(entry.vehicle_distribution || {}),
            ...Object.keys(exit.vehicle_distribution || {})
        ]);

        const netDistribution = {};
        allTypes.forEach(type => {
            netDistribution[type] = (entry.vehicle_distribution[type] || 0) -
                                    (exit.vehicle_distribution[type] || 0);
        });

        // Aggregate totals
        const aggregated = {
            vehicles_in: (entry.vehicles_in || 0) + (exit.vehicles_in || 0),
            vehicles_out: (entry.vehicles_out || 0) + (exit.vehicles_out || 0),
            net_vehicles: (entry.net_vehicles || 0) + (exit.net_vehicles || 0),
            people_on_site_min: (entry.people_on_site_min || 0) + (exit.people_on_site_min || 0),
            people_on_site_max: (entry.people_on_site_max || 0) + (exit.people_on_site_max || 0),
            vehicle_distribution: netDistribution
        };

        this.updateDisplay(aggregated);
    }

    /**
     * Updates DOM elements with statistics
     */
    updateDisplay(stats) {
        const { vehiclesIn, vehiclesOut, netVehicles, peopleRange } = this.elements;

        if (vehiclesIn) vehiclesIn.textContent = stats.vehicles_in || 0;
        if (vehiclesOut) vehiclesOut.textContent = stats.vehicles_out || 0;
        if (netVehicles) netVehicles.textContent = stats.net_vehicles || 0;
        if (peopleRange) {
            peopleRange.textContent = `${stats.people_on_site_min || 0} - ${stats.people_on_site_max || 0}`;
        }

        if (stats.vehicle_distribution) {
            this.updateDistributionChart(stats.vehicle_distribution);
        }
    }

    async fetchInitialData() {
        try {
            const response = await fetch('/api/statistics');
            if (response.ok) {
                const stats = await response.json();
                this.updateDisplay(stats);
            }
        } catch (error) {
            console.error('Failed to fetch initial data:', error);
        }
    }

    /**
     * Resets all statistics to zero
     */
    resetStats() {
        this.cameraStats = {
            [CAMERA_ROLES.ENTRY]: createEmptyStats(),
            [CAMERA_ROLES.EXIT]: createEmptyStats()
        };
        this.eventCount = 0;
        this.refreshDashboard();

        if (this.charts.distribution) {
            this.charts.distribution.data.datasets[0].data = [...CONFIG.DEFAULT_CHART_DATA];
            this.charts.distribution.update('none');
        }
    }

    // -------------------------------------------------------------------------
    // Event Log
    // -------------------------------------------------------------------------

    addEventToLog(event) {
        const { eventLogBody, eventCount } = this.elements;
        if (!eventLogBody) return;

        // Remove empty placeholder row
        const emptyRow = eventLogBody.querySelector('.empty-row');
        if (emptyRow) emptyRow.remove();

        // Create new row
        const row = document.createElement('tr');
        row.className = 'new-event';

        const directionClass = event.direction === 'IN' ? 'badge-in' : 'badge-out';
        const vehicleClass = `badge-${event.vehicle_type.toLowerCase()}`;

        row.innerHTML = `
            <td>${formatTimestamp(event.timestamp)}</td>
            <td><span class="badge ${vehicleClass}">${event.vehicle_type}</span></td>
            <td><span class="badge ${directionClass}">${event.direction}</span></td>
            <td>${event.seats_min} - ${event.seats_max}</td>
        `;

        // Insert at top and trim if needed
        eventLogBody.insertBefore(row, eventLogBody.firstChild);
        while (eventLogBody.children.length > CONFIG.MAX_LOG_EVENTS) {
            eventLogBody.removeChild(eventLogBody.lastChild);
        }

        // Update count
        this.eventCount++;
        if (eventCount) eventCount.textContent = `${this.eventCount} events`;

        // Remove highlight after animation
        setTimeout(() => row.classList.remove('new-event'), CONFIG.NEW_EVENT_HIGHLIGHT_MS);
    }

    clearEventLog() {
        const { eventLogBody, eventCount } = this.elements;
        if (eventLogBody) {
            eventLogBody.innerHTML = '<tr class="empty-row"><td colspan="4" class="text-center text-secondary">No events yet</td></tr>';
        }
        if (eventCount) eventCount.textContent = '0 events';
        this.eventCount = 0;
    }

    // -------------------------------------------------------------------------
    // Charts
    // -------------------------------------------------------------------------

    setupCharts() {
        const ctx = getElement('distributionChart');
        if (!ctx) return;

        this.charts.distribution = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: CONFIG.VEHICLE_TYPES,
                datasets: [{
                    label: 'Count',
                    data: [...CONFIG.DEFAULT_CHART_DATA],
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

    updateDistributionChart(distribution) {
        if (!this.charts.distribution || !distribution) return;

        this.charts.distribution.data.labels = Object.keys(distribution);
        this.charts.distribution.data.datasets[0].data = Object.values(distribution);
        this.charts.distribution.update('none');
    }

    // -------------------------------------------------------------------------
    // UI Helpers
    // -------------------------------------------------------------------------

    setupTimeFilter() {
        document.querySelectorAll('.time-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.time-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
            });
        });
    }

    showNotification(title, message, type = 'info') {
        const notification = document.createElement('div');
        notification.className = `notification notification-${type}`;
        notification.innerHTML = `<strong>${title}</strong><p>${message}</p>`;

        document.body.appendChild(notification);

        setTimeout(() => {
            notification.classList.add('fade-out');
            setTimeout(() => notification.remove(), 300);
        }, CONFIG.NOTIFICATION_DURATION_MS);
    }
}

// =============================================================================
// WORKBENCH MANAGER
// =============================================================================

/**
 * Manages the camera workbench UI for video upload and line drawing
 * Handles dual-camera configuration and analysis controls
 */
class WorkbenchManager {
    constructor() {
        this.currentCameraRole = CAMERA_ROLES.ENTRY;
        this.sessionCompleted = false;
        this.sourceType = SOURCE_TYPE.FILE;  // Current source type selection
        this.hasLiveStreams = false;  // Track if any camera is using live stream

        // LineDrawer instances per camera
        this.lineDrawers = {
            [CAMERA_ROLES.ENTRY]: null,
            [CAMERA_ROLES.EXIT]: null
        };

        // Camera configurations
        this.cameraConfigs = {
            [CAMERA_ROLES.ENTRY]: createCameraConfig(),
            [CAMERA_ROLES.EXIT]: createCameraConfig()
        };

        // Cache DOM element references
        this.cameraElements = this.initCameraElements();
        this.globalElements = this.initGlobalElements();

        this.init();
    }

    /**
     * Initializes camera-specific DOM element references
     */
    initCameraElements() {
        const elements = {};
        
        Object.values(CAMERA_ROLES).forEach(role => {
            const prefix = role.toLowerCase();
            elements[role] = {
                canvas: getElement(`${prefix}-canvas`),
                placeholder: getElement(`${prefix}-placeholder`),
                liveFeed: getElement(`${prefix}-live-feed`),
                statusText: getElement(`${prefix}-camera-status`),
                card: getElement(`${prefix}-camera-card`),
                progressBar: getElement(`${prefix}-progress-bar`),
                progressText: getElement(`${prefix}-progress-text`)
            };
        });

        return elements;
    }

    /**
     * Initializes global DOM element references
     */
    initGlobalElements() {
        return {
            videoUpload: getElement('video-upload'),
            fileName: getElement('file-name-display'),
            startBtn: getElement('btn-start-analysis'),
            stopBtn: getElement('btn-stop-analysis'),
            clearLineBtn: getElement('clear-line-btn'),
            configStatusText: getElement('config-status-text'),
            configStatusDot: getElement('config-status-dot'),
            processingStatus: getElement('processing-status'),
            locationInput: getElement('location-input'),
            modeLabel: getElement('mode-label'),
            liveBadge: getElement('live-badge'),
            // Source type elements
            sourceFileBtn: getElement('source-file-btn'),
            sourceStreamBtn: getElement('source-stream-btn'),
            fileSourceConfig: getElement('file-source-config'),
            streamSourceConfig: getElement('stream-source-config'),
            streamUrlInput: getElement('stream-url-input'),
            streamStatusDisplay: getElement('stream-status-display')
        };
    }

    init() {
        this.setupEventListeners();
        this.updateStartButtonState();
        this.highlightSelectedCamera();
    }

    // -------------------------------------------------------------------------
    // Event Listeners
    // -------------------------------------------------------------------------

    setupEventListeners() {
        const { videoUpload, clearLineBtn, startBtn, stopBtn } = this.globalElements;

        if (videoUpload) {
            videoUpload.addEventListener('change', (e) => this.handleVideoUpload(e));
        }
        if (clearLineBtn) {
            clearLineBtn.addEventListener('click', () => this.resetLine());
        }
        if (startBtn) {
            startBtn.addEventListener('click', () => this.startAnalysis());
        }
        if (stopBtn) {
            stopBtn.addEventListener('click', () => this.stopAnalysis());
        }
    }

    // -------------------------------------------------------------------------
    // Source Type Management
    // -------------------------------------------------------------------------

    /**
     * Switch between file upload and live stream source types
     * @param {string} type - 'file' or 'stream'
     */
    setSourceType(type) {
        this.sourceType = type;
        const { sourceFileBtn, sourceStreamBtn, fileSourceConfig, streamSourceConfig } = this.globalElements;

        if (type === SOURCE_TYPE.FILE) {
            sourceFileBtn?.classList.add('active');
            sourceStreamBtn?.classList.remove('active');
            fileSourceConfig?.classList.remove('hidden');
            streamSourceConfig?.classList.add('hidden');
        } else {
            sourceFileBtn?.classList.remove('active');
            sourceStreamBtn?.classList.add('active');
            fileSourceConfig?.classList.add('hidden');
            streamSourceConfig?.classList.remove('hidden');
        }

        feather.replace();
    }

    /**
     * Connect to a live stream and capture first frame
     */
    async connectStream() {
        const { streamUrlInput, streamStatusDisplay } = this.globalElements;
        const streamUrl = streamUrlInput?.value?.trim();

        if (!streamUrl) {
            alert('Please enter a stream URL');
            return;
        }

        // Validate URL format
        if (!streamUrl.match(/^(rtsp|http|https|rtmp):\/\//i)) {
            alert('Invalid URL. Must start with rtsp://, http://, https://, or rtmp://');
            return;
        }

        streamStatusDisplay.textContent = 'Connecting...';

        try {
            const response = await fetch('/setup/configure-stream', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    stream_url: streamUrl,
                    camera_role: this.currentCameraRole
                })
            });
            const data = await response.json();

            if (data.success) {
                const config = this.cameraConfigs[this.currentCameraRole];
                config.hasVideo = true;
                config.videoName = 'Live Stream';
                config.isLiveStream = true;
                this.hasLiveStreams = true;

                streamStatusDisplay.textContent = 'Connected';
                streamStatusDisplay.style.color = 'var(--success-color)';

                // Load the captured frame for line drawing
                await this.loadStreamFrame(this.currentCameraRole, data.frame, data.line_points);
                this.updateStartButtonState();
            } else {
                streamStatusDisplay.textContent = data.error || 'Connection failed';
                streamStatusDisplay.style.color = 'var(--danger-color)';
            }
        } catch (error) {
            streamStatusDisplay.textContent = 'Connection error';
            streamStatusDisplay.style.color = 'var(--danger-color)';
            console.error('Stream connection error:', error);
        }
    }

    /**
     * Load a stream frame for line drawing
     */
    async loadStreamFrame(role, frameBase64, existingLinePoints) {
        const camEls = this.cameraElements[role];
        const config = this.cameraConfigs[role];

        // Update visibility
        if (camEls.placeholder) camEls.placeholder.style.display = 'none';
        if (camEls.canvas) camEls.canvas.style.display = 'block';
        if (camEls.liveFeed) camEls.liveFeed.classList.add('hidden');

        // Create LineDrawer
        const canvasId = `${role.toLowerCase()}-canvas`;
        this.lineDrawers[role] = new LineDrawer(canvasId);
        await this.lineDrawers[role].loadImage('data:image/jpeg;base64,' + frameBase64);

        // Restore existing line if present
        if (existingLinePoints) {
            this.lineDrawers[role].setLinePoints(existingLinePoints);
            config.hasLine = true;
            this.updateCameraStatusText(role);
            this.updateStartButtonState();
        }

        // Set up line completion callback
        this.lineDrawers[role].onLineComplete = (points) => {
            config.hasLine = true;
            this.updateCameraStatusText(role);
            this.updateStartButtonState();
            this.saveLine(role, points);

            if (this.currentCameraRole === role) {
                this.globalElements.clearLineBtn.disabled = false;
                this.updateSidebarStatus();
            }
        };

        this.updateCameraStatusText(role);
    }

    // -------------------------------------------------------------------------
    // Camera Selection
    // -------------------------------------------------------------------------

    highlightSelectedCamera() {
        Object.values(CAMERA_ROLES).forEach(role => {
            const card = this.cameraElements[role].card;
            if (card) {
                card.classList.toggle('active', role === this.currentCameraRole);
            }
        });
    }

    switchCameraContext(role) {
        this.currentCameraRole = role;

        // Update tab UI
        document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
        const activeTabId = role === CAMERA_ROLES.ENTRY ? 'tab-entry' : 'tab-exit';
        const activeTab = getElement(activeTabId);
        if (activeTab) activeTab.classList.add('active');

        this.highlightSelectedCamera();

        // Update file name display
        const config = this.cameraConfigs[role];
        this.globalElements.fileName.textContent = config.videoName || 'No file selected';

        // Update sidebar and clear button
        this.updateSidebarStatus();
        this.globalElements.clearLineBtn.disabled = !config.hasLine;
    }

    // -------------------------------------------------------------------------
    // Status Updates
    // -------------------------------------------------------------------------

    updateSidebarStatus() {
        const config = this.cameraConfigs[this.currentCameraRole];
        const { configStatusText, configStatusDot } = this.globalElements;

        const statusMap = {
            [PROCESSING_STATUS.PROCESSING]: { text: 'Processing...', dot: 'processing' },
            [PROCESSING_STATUS.COMPLETED]: { text: 'Analysis Complete', dot: 'ready' }
        };

        if (statusMap[config.processingStatus]) {
            const { text, dot } = statusMap[config.processingStatus];
            configStatusText.textContent = text;
            configStatusDot.className = `status-dot ${dot}`;
        } else if (config.hasLine) {
            configStatusText.textContent = 'Ready';
            configStatusDot.className = 'status-dot ready';
        } else if (config.hasVideo) {
            configStatusText.textContent = 'Draw counting line';
            configStatusDot.className = 'status-dot warning';
        } else {
            configStatusText.textContent = 'Upload video';
            configStatusDot.className = 'status-dot error';
        }
    }

    updateCameraStatusText(role) {
        const config = this.cameraConfigs[role];
        const statusEl = this.cameraElements[role].statusText;
        if (!statusEl) return;

        // Handle processing status
        if (config.processingStatus === PROCESSING_STATUS.PROCESSING) {
            if (config.isLiveStream || config.progress === -1) {
                statusEl.textContent = 'LIVE';
                statusEl.className = 'camera-status live';
            } else {
                statusEl.textContent = `Processing ${config.progress}%`;
                statusEl.className = 'camera-status processing';
            }
        } else if (config.processingStatus === PROCESSING_STATUS.COMPLETED) {
            statusEl.textContent = 'Completed';
            statusEl.className = 'camera-status completed';
        } else if (config.processingStatus === PROCESSING_STATUS.STOPPED) {
            statusEl.textContent = 'Stopped';
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
        const { progressBar, progressText } = this.cameraElements[role];

        // Handle live stream display
        if (config.isLiveStream || config.progress === -1) {
            if (progressBar) progressBar.style.width = '100%';
            if (progressText) progressText.textContent = 'LIVE';
        } else {
            const progress = config.progress || 0;
            if (progressBar) progressBar.style.width = `${progress}%`;
            if (progressText) progressText.textContent = `${progress}%`;
        }
    }

    // -------------------------------------------------------------------------
    // Processing Updates (from Socket)
    // -------------------------------------------------------------------------

    handleProcessingUpdate(data) {
        if (!data.camera_role) return;

        const config = this.cameraConfigs[data.camera_role];
        if (!config) return;

        config.processingStatus = data.status;
        if (data.progress !== undefined) config.progress = data.progress;

        this.updateCameraStatusText(data.camera_role);
        this.updateCameraProgress(data.camera_role);

        if (this.currentCameraRole === data.camera_role) {
            this.updateSidebarStatus();
        }

        this.checkAllCompleted();
    }

    handleProgressUpdate(data) {
        if (!data.camera_role) return;

        const config = this.cameraConfigs[data.camera_role];
        if (!config) return;

        // Handle live stream progress differently
        if (data.is_live || data.progress === -1) {
            config.progress = -1;  // -1 indicates live stream
            config.isLiveStream = true;
        } else {
            config.progress = data.progress;
        }

        if (config.processingStatus === PROCESSING_STATUS.PENDING) {
            config.processingStatus = PROCESSING_STATUS.PROCESSING;
        }

        this.updateCameraProgress(data.camera_role);
        this.updateCameraStatusText(data.camera_role);

        if (this.currentCameraRole === data.camera_role) {
            this.updateSidebarStatus();
        }
    }

    checkAllCompleted() {
        const allDone = Object.values(CAMERA_ROLES).every(
            role => this.cameraConfigs[role].processingStatus === PROCESSING_STATUS.COMPLETED ||
                   this.cameraConfigs[role].processingStatus === PROCESSING_STATUS.STOPPED
        );

        const anyProcessing = Object.values(CAMERA_ROLES).some(
            role => this.cameraConfigs[role].processingStatus === PROCESSING_STATUS.PROCESSING
        );

        // Show/hide stop button based on processing state and live streams
        if (anyProcessing && this.hasLiveStreams) {
            this.globalElements.stopBtn?.classList.remove('hidden');
        } else {
            this.globalElements.stopBtn?.classList.add('hidden');
        }

        if (allDone) {
            this.sessionCompleted = true;
            this.hasLiveStreams = false;

            // Disable continue mode
            if (window.dashboardManager) {
                window.dashboardManager.setContinueMode(false);
            }

            this.globalElements.startBtn.innerHTML = `<i data-feather="check"></i> Analysis Complete`;
            this.globalElements.startBtn.disabled = true;
            this.globalElements.stopBtn?.classList.add('hidden');
            this.globalElements.processingStatus.classList.add('hidden');
            feather.replace();
        }
    }

    // -------------------------------------------------------------------------
    // Video Upload & Configuration
    // -------------------------------------------------------------------------

    async handleVideoUpload(e) {
        if (!e.target.files?.length) return;

        const file = e.target.files[0];

        // Handle session continuation choice
        if (this.sessionCompleted) {
            const choice = await this.showSessionChoiceModal();
            
            if (choice === 'new') {
                this.resetSession();
                window.dashboardManager?.setContinueMode(false);
            } else {
                window.dashboardManager?.setContinueMode(true);
            }
            
            this.sessionCompleted = false;
        }

        this.globalElements.fileName.textContent = file.name;

        try {
            const formData = new FormData();
            formData.append('video', file);
            formData.append('camera_role', this.currentCameraRole);

            const response = await fetch('/setup/upload-video', {
                method: 'POST',
                body: formData
            });
            const data = await response.json();

            if (data.success) {
                const config = this.cameraConfigs[this.currentCameraRole];
                config.hasVideo = true;
                config.videoName = file.name;

                await this.loadFirstFrame(this.currentCameraRole);
                this.updateStartButtonState();
            } else {
                alert('Upload failed: ' + data.error);
            }
        } catch (error) {
            alert('Error uploading video: ' + error.message);
        }
    }

    async loadFirstFrame(role) {
        const camEls = this.cameraElements[role];
        const config = this.cameraConfigs[role];

        try {
            const response = await fetch(`/setup/get-first-frame?camera_role=${role}`);
            const data = await response.json();

            if (!data.frame) return;

            // Update visibility
            if (camEls.placeholder) camEls.placeholder.style.display = 'none';
            if (camEls.canvas) camEls.canvas.style.display = 'block';
            if (camEls.liveFeed) camEls.liveFeed.classList.add('hidden');

            // Create LineDrawer
            const canvasId = `${role.toLowerCase()}-canvas`;
            this.lineDrawers[role] = new LineDrawer(canvasId);
            await this.lineDrawers[role].loadImage('data:image/jpeg;base64,' + data.frame);

            // Restore existing line if present
            if (data.line_points) {
                this.lineDrawers[role].setLinePoints(data.line_points);
                config.hasLine = true;
                this.updateCameraStatusText(role);
                this.updateStartButtonState();
            }

            // Set up line completion callback
            this.lineDrawers[role].onLineComplete = (points) => {
                config.hasLine = true;
                this.updateCameraStatusText(role);
                this.updateStartButtonState();
                this.saveLine(role, points);

                if (this.currentCameraRole === role) {
                    this.globalElements.clearLineBtn.disabled = false;
                    this.updateSidebarStatus();
                }
            };

            this.updateCameraStatusText(role);
        } catch (error) {
            console.error(`Error loading frame for ${role}:`, error);
        }
    }

    async saveLine(role, points) {
        try {
            await fetch('/setup/save-line', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ line_points: points, camera_role: role })
            });
            console.log(`Line auto-saved for ${role}`);
        } catch (error) {
            console.error(`Failed to auto-save line for ${role}:`, error);
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
            this.globalElements.clearLineBtn.disabled = true;
        }
    }

    // -------------------------------------------------------------------------
    // Analysis Control
    // -------------------------------------------------------------------------

    updateStartButtonState() {
        // const allReady = Object.values(CAMERA_ROLES).every(role => {
        //     const config = this.cameraConfigs[role];
        //     return config.hasVideo && config.hasLine;
        // });
        const anyReady = Object.values(CAMERA_ROLES).some(role => {
            const config = this.cameraConfigs[role];
            return config.hasVideo && config.hasLine;
        });

        const anyProcessing = Object.values(CAMERA_ROLES).some(
            role => this.cameraConfigs[role].processingStatus === PROCESSING_STATUS.PROCESSING
        );

        const { startBtn } = this.globalElements;

        // if (anyProcessing) {
        //     startBtn.disabled = true;
        // } else if (allReady) {
        //     startBtn.disabled = false;
        //     startBtn.innerHTML = `<i data-feather="play"></i> Start Analysis`;
        //     feather.replace();
        // } else {
        //     startBtn.disabled = true;
        // }
        if (anyProcessing || anyReady) {
            startBtn.disabled = false;
            startBtn.innerHTML = `<i data-feather="play"></i> Start Analysis`;
            feather.replace();
        } else {
            startBtn.disabled = true;
        }
    }

    async startAnalysis() {
        // Identify which cameras are actually ready
        const readyCameras = Object.values(CAMERA_ROLES).filter(role => {
            const config = this.cameraConfigs[role];
            return config.hasVideo && config.hasLine;
        });
        // Validation checks if list is empty, rather than checking specific roles
        if (readyCameras.length === 0) {
            alert(`Please configure at least one camera (upload video and draw line).`);
            return;
        }
        // Show processing UI
        const { processingStatus, startBtn, locationInput } = this.globalElements;
        processingStatus.classList.remove('hidden');
        startBtn.disabled = true;
        startBtn.innerHTML = `<i data-feather="loader" class="spin"></i> Processing...`;
        feather.replace();

        const location = locationInput.value || 'Unknown';
        let sessionId = null;

        try {
            // Start processing for each camera
            for (const role of readyCameras) {
                const response = await fetch('/setup/start-processing', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ location, camera_role: role })
                });
                const data = await response.json();

                if (data.success) {
                    if (!sessionId) sessionId = data.session_id;
                    this.cameraConfigs[role].processingStatus = PROCESSING_STATUS.PROCESSING;
                    
                    // Track if this is a live stream
                    if (data.is_live_stream) {
                        this.cameraConfigs[role].isLiveStream = true;
                        this.hasLiveStreams = true;
                    }
                    
                    this.updateCameraStatusText(role);
                    this.setAnalysisMode(true, role);
                } else {
                    throw new Error(`${role} camera: ${data.error}`);
                }
            }

            // Show stop button for live streams
            if (this.hasLiveStreams) {
                this.globalElements.stopBtn?.classList.remove('hidden');
            }

            // Join socket room
            if (window.dashboardManager?.socket && sessionId) {
                window.dashboardManager.sessionId = sessionId;
                window.dashboardManager.socket.emit('join_session', { session_id: sessionId });
            }
        } catch (error) {
            alert('Failed to start processing: ' + error.message);
            startBtn.disabled = false;
            startBtn.innerHTML = `<i data-feather="play"></i> Start Analysis`;
            processingStatus.classList.add('hidden');
            feather.replace();
        }
    }

    setAnalysisMode(isActive, cameraRole) {
        if (!isActive) return;

        console.log(`Setting analysis mode for ${cameraRole} camera`);

        const camEls = this.cameraElements[cameraRole];

        // Hide canvas, show live feed
        if (camEls.canvas) camEls.canvas.style.display = 'none';
        if (camEls.liveFeed) {
            camEls.liveFeed.style.display = 'block';
            camEls.liveFeed.classList.remove('hidden');
            camEls.liveFeed.src = `/video-feed/${cameraRole}`;
            console.log(`Started live stream: /video-feed/${cameraRole}`);
        }

        this.globalElements.liveBadge.classList.remove('hidden');
        this.globalElements.modeLabel.textContent = 'Live Analysis';
    }

    /**
     * Stop all running analysis (for live streams)
     */
    async stopAnalysis() {
        const { stopBtn, startBtn, processingStatus } = this.globalElements;

        stopBtn.disabled = true;
        stopBtn.innerHTML = `<i data-feather="loader" class="spin"></i> Stopping...`;
        feather.replace();

        try {
            const response = await fetch('/setup/stop-processing', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({})  // Stop all cameras
            });
            const data = await response.json();

            if (data.success) {
                console.log('Stop signal sent successfully');
                
                // Update UI - the actual completion will come via socket events
                Object.values(CAMERA_ROLES).forEach(role => {
                    const config = this.cameraConfigs[role];
                    if (config.processingStatus === PROCESSING_STATUS.PROCESSING) {
                        config.processingStatus = PROCESSING_STATUS.STOPPED;
                        this.updateCameraStatusText(role);
                    }
                });

                this.sessionCompleted = true;
                this.hasLiveStreams = false;
                
                stopBtn.classList.add('hidden');
                startBtn.innerHTML = `<i data-feather="check"></i> Analysis Stopped`;
                startBtn.disabled = true;
                processingStatus.classList.add('hidden');
            }
        } catch (error) {
            console.error('Failed to stop analysis:', error);
            alert('Failed to stop analysis: ' + error.message);
        }

        stopBtn.disabled = false;
        stopBtn.innerHTML = `<i data-feather="square"></i> Stop Analysis`;
        feather.replace();
    }

    // -------------------------------------------------------------------------
    // Session Management
    // -------------------------------------------------------------------------

    /**
     * Shows modal for session continuation choice
     * @returns {Promise<'continue'|'new'>}
     */
    showSessionChoiceModal() {
        return new Promise((resolve) => {
            const modal = getElement('session-choice-modal');
            const continueBtn = getElement('btn-continue-session');
            const newBtn = getElement('btn-new-session');

            modal.classList.remove('hidden');
            feather.replace();

            const cleanup = () => {
                continueBtn.removeEventListener('click', handleContinue);
                newBtn.removeEventListener('click', handleNew);
            };

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

            continueBtn.addEventListener('click', handleContinue);
            newBtn.addEventListener('click', handleNew);
        });
    }

    /**
     * Resets all session data for a fresh start
     */
    resetSession() {
        console.log('Resetting session...');

        // Reset dashboard stats
        window.dashboardManager?.resetStats();
        window.dashboardManager?.clearEventLog();

        // Reset camera configs
        Object.values(CAMERA_ROLES).forEach(role => {
            this.cameraConfigs[role] = createCameraConfig();
            this.lineDrawers[role] = null;

            // Reset camera UI
            const camEls = this.cameraElements[role];
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

        // Reset global UI
        const { startBtn, processingStatus, liveBadge, modeLabel, fileName, clearLineBtn } = this.globalElements;
        startBtn.innerHTML = `<i data-feather="play"></i> Start Analysis`;
        startBtn.disabled = true;
        processingStatus.classList.add('hidden');
        liveBadge.classList.add('hidden');
        modeLabel.textContent = 'Setup';
        fileName.textContent = 'No file selected';
        clearLineBtn.disabled = true;

        this.updateSidebarStatus();
        feather.replace();

        console.log('Session reset complete');
    }
}

// =============================================================================
// GLOBAL FUNCTIONS & INITIALIZATION
// =============================================================================

/**
 * Global function to switch camera context (called from HTML)
 */
function switchCameraContext(role) {
    window.workbenchManager?.switchCameraContext(role);
}

// Initialize managers when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.dashboardManager = new DashboardManager();
    window.workbenchManager = new WorkbenchManager();
});
