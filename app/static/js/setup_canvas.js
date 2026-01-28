/**
 * LineDrawer - Canvas-based line drawing tool for counting line configuration
 * 
 * Allows users to draw a counting line on a video frame by clicking and dragging.
 * The line is used to detect vehicles crossing for traffic analysis.
 */
class LineDrawer {
    // Configuration constants
    static LINE_COLOR = '#00ff00';
    static LINE_WIDTH = 3;
    static ENDPOINT_RADIUS = 5;

    /**
     * Creates a new LineDrawer instance
     * @param {string} canvasId - The ID of the canvas element to draw on
     */
    constructor(canvasId) {
        this.canvas = document.getElementById(canvasId);
        if (!this.canvas) {
            console.error(`Canvas element not found: ${canvasId}`);
            return;
        }

        this.ctx = this.canvas.getContext('2d');
        this.isDrawing = false;
        this.startPoint = null;
        this.endPoint = null;
        this.backgroundImage = null;

        // Callback for when line drawing is complete
        this.onLineComplete = null;

        this.setupEventListeners();
    }

    /**
     * Sets up mouse event listeners for drawing interaction
     */
    setupEventListeners() {
        // Bind methods to preserve context
        this.handleMouseDown = this.handleMouseDown.bind(this);
        this.handleMouseMove = this.handleMouseMove.bind(this);
        this.handleMouseUp = this.handleMouseUp.bind(this);
        this.handleMouseLeave = this.handleMouseLeave.bind(this);

        this.canvas.addEventListener('mousedown', this.handleMouseDown);
        this.canvas.addEventListener('mousemove', this.handleMouseMove);
        this.canvas.addEventListener('mouseup', this.handleMouseUp);
        this.canvas.addEventListener('mouseleave', this.handleMouseLeave);
    }

    /**
     * Loads a background image onto the canvas
     * @param {string} imageSrc - The image source URL or data URI
     * @returns {Promise<void>}
     */
    loadImage(imageSrc) {
        return new Promise((resolve, reject) => {
            const img = new Image();

            img.onload = () => {
                this.backgroundImage = img;
                this.canvas.width = img.width;
                this.canvas.height = img.height;
                this.canvas.style.display = 'block';
                this.canvas.style.cursor = 'crosshair';
                this.redraw();
                resolve();
            };

            img.onerror = () => {
                reject(new Error('Failed to load image'));
            };

            img.src = imageSrc;
        });
    }

    /**
     * Calculates mouse position relative to canvas, accounting for scaling
     * @param {MouseEvent} event - The mouse event
     * @returns {{x: number, y: number}} The adjusted coordinates
     */
    getMousePos(event) {
        const rect = this.canvas.getBoundingClientRect();
        const scaleX = this.canvas.width / rect.width;
        const scaleY = this.canvas.height / rect.height;

        return {
            x: (event.clientX - rect.left) * scaleX,
            y: (event.clientY - rect.top) * scaleY
        };
    }

    /**
     * Handles mouse down event - starts drawing
     */
    handleMouseDown(event) {
        event.preventDefault();
        this.startPoint = this.getMousePos(event);
        this.endPoint = null;
        this.isDrawing = true;
    }

    /**
     * Handles mouse move event - updates line preview while drawing
     */
    handleMouseMove(event) {
        if (!this.isDrawing) return;
        event.preventDefault();
        this.endPoint = this.getMousePos(event);
        this.redraw();
    }

    /**
     * Handles mouse up event - completes line drawing
     */
    handleMouseUp(event) {
        if (!this.isDrawing) return;
        event.preventDefault();

        this.endPoint = this.getMousePos(event);
        this.isDrawing = false;
        this.redraw();
        this.notifyLineComplete();
    }

    /**
     * Handles mouse leave event - completes line if valid
     */
    handleMouseLeave(event) {
        if (this.isDrawing && this.startPoint && this.endPoint) {
            this.isDrawing = false;
            this.notifyLineComplete();
        }
    }

    /**
     * Notifies callback that line drawing is complete
     */
    notifyLineComplete() {
        if (this.onLineComplete && this.startPoint && this.endPoint) {
            this.onLineComplete(this.getLinePoints());
        }
    }

    /**
     * Redraws the canvas with background image and line
     */
    redraw() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // Draw background
        if (this.backgroundImage) {
            this.ctx.drawImage(this.backgroundImage, 0, 0);
        }

        // Draw line if both points exist
        if (this.startPoint && this.endPoint) {
            this.drawLine();
            this.drawEndpoints();
        }
    }

    /**
     * Draws the counting line
     */
    drawLine() {
        this.ctx.beginPath();
        this.ctx.moveTo(this.startPoint.x, this.startPoint.y);
        this.ctx.lineTo(this.endPoint.x, this.endPoint.y);
        this.ctx.strokeStyle = LineDrawer.LINE_COLOR;
        this.ctx.lineWidth = LineDrawer.LINE_WIDTH;
        this.ctx.stroke();
    }

    /**
     * Draws circular endpoints at line start and end
     */
    drawEndpoints() {
        this.ctx.fillStyle = LineDrawer.LINE_COLOR;

        // Start point
        this.ctx.beginPath();
        this.ctx.arc(
            this.startPoint.x,
            this.startPoint.y,
            LineDrawer.ENDPOINT_RADIUS,
            0,
            2 * Math.PI
        );
        this.ctx.fill();

        // End point
        this.ctx.beginPath();
        this.ctx.arc(
            this.endPoint.x,
            this.endPoint.y,
            LineDrawer.ENDPOINT_RADIUS,
            0,
            2 * Math.PI
        );
        this.ctx.fill();
    }

    /**
     * Gets the current line points as an array
     * @returns {Array<Array<number>>} Array of [x, y] coordinate pairs
     */
    getLinePoints() {
        if (!this.startPoint || !this.endPoint) return null;

        return [
            [this.startPoint.x, this.startPoint.y],
            [this.endPoint.x, this.endPoint.y]
        ];
    }

    /**
     * Sets line points from saved data
     * @param {Array<Array<number>>} points - Array of [x, y] coordinate pairs
     */
    setLinePoints(points) {
        if (!points || points.length !== 2) return;

        this.startPoint = { x: points[0][0], y: points[0][1] };
        this.endPoint = { x: points[1][0], y: points[1][1] };
        this.redraw();
    }

    /**
     * Resets the line, clearing start and end points
     */
    reset() {
        this.startPoint = null;
        this.endPoint = null;
        this.redraw();
    }

    /**
     * Checks if a valid line has been drawn
     * @returns {boolean}
     */
    hasLine() {
        return this.startPoint !== null && this.endPoint !== null;
    }

    /**
     * Cleans up event listeners (call when destroying instance)
     */
    destroy() {
        this.canvas.removeEventListener('mousedown', this.handleMouseDown);
        this.canvas.removeEventListener('mousemove', this.handleMouseMove);
        this.canvas.removeEventListener('mouseup', this.handleMouseUp);
        this.canvas.removeEventListener('mouseleave', this.handleMouseLeave);
    }
}
