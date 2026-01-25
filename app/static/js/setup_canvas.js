class LineDrawer {
    constructor(canvasId) {
        this.canvas = document.getElementById(canvasId);
        this.ctx = this.canvas.getContext('2d');
        this.isDrawing = false;
        this.startPoint = null;
        this.endPoint = null;
        this.backgroundImage = null;

        this.setupEventListeners();
    }

    setupEventListeners() {
        this.canvas.addEventListener('mousedown', (e) => this.handleMouseDown(e));
        this.canvas.addEventListener('mousemove', (e) => this.handleMouseMove(e));
        this.canvas.addEventListener('mouseup', (e) => this.handleMouseUp(e));
        // Also handle mouse leaving canvas while drawing
        this.canvas.addEventListener('mouseleave', (e) => {
            if (this.isDrawing && this.startPoint && this.endPoint) {
                this.isDrawing = false;
                if (this.onLineComplete) {
                    this.onLineComplete(this.getLinePoints());
                }
            }
        });
    }

    loadImage(imageSrc) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                this.backgroundImage = img;
                this.canvas.width = img.width;
                this.canvas.height = img.height;
                // Make canvas visible and interactive
                this.canvas.style.display = 'block';
                this.canvas.style.cursor = 'crosshair';
                this.redraw();
                resolve();
            };
            img.onerror = reject;
            img.src = imageSrc;
        });
    }

    // Get mouse position accounting for canvas scaling
    getMousePos(e) {
        const rect = this.canvas.getBoundingClientRect();
        const scaleX = this.canvas.width / rect.width;
        const scaleY = this.canvas.height / rect.height;
        return {
            x: (e.clientX - rect.left) * scaleX,
            y: (e.clientY - rect.top) * scaleY
        };
    }

    handleMouseDown(e) {
        e.preventDefault();
        this.startPoint = this.getMousePos(e);
        this.endPoint = null;
        this.isDrawing = true;
    }

    handleMouseMove(e) {
        if (!this.isDrawing) return;
        e.preventDefault();
        this.endPoint = this.getMousePos(e);
        this.redraw();
    }

    handleMouseUp(e) {
        if (!this.isDrawing) return;
        e.preventDefault();
        this.endPoint = this.getMousePos(e);
        this.isDrawing = false;
        this.redraw();

        // Notify line is complete
        if (this.onLineComplete && this.startPoint && this.endPoint) {
            this.onLineComplete(this.getLinePoints());
        }
    }

    redraw() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        if (this.backgroundImage) {
            this.ctx.drawImage(this.backgroundImage, 0, 0);
        }

        if (this.startPoint && this.endPoint) {
            this.ctx.beginPath();
            this.ctx.moveTo(this.startPoint.x, this.startPoint.y);
            this.ctx.lineTo(this.endPoint.x, this.endPoint.y);
            this.ctx.strokeStyle = '#00ff00';
            this.ctx.lineWidth = 3;
            this.ctx.stroke();

            // Draw endpoints
            this.ctx.fillStyle = '#00ff00';
            this.ctx.beginPath();
            this.ctx.arc(this.startPoint.x, this.startPoint.y, 5, 0, 2 * Math.PI);
            this.ctx.fill();
            this.ctx.beginPath();
            this.ctx.arc(this.endPoint.x, this.endPoint.y, 5, 0, 2 * Math.PI);
            this.ctx.fill();
        }
    }

    getLinePoints() {
        return [
            [this.startPoint.x, this.startPoint.y],
            [this.endPoint.x, this.endPoint.y]
        ];
    }

    reset() {
        this.startPoint = null;
        this.endPoint = null;
        this.redraw();
    }
}