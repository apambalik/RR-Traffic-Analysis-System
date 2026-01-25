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

// Initialize dashboard when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.dashboardManager = new DashboardManager();
});
