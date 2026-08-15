var rfb = require('rfb2');

module.exports = function(RED) {

    function vncClientNode(n) {

        RED.nodes.createNode(this, n);

        var node = this;

        // ============================================================
        // Configuration
        // ============================================================

        this.host = n.host;
        this.port = Number(n.port) || 5900;
        this.password = n.password;

        // ============================================================
        // Connection state
        // ============================================================

        this.rfb = null;

        this.connected = false;
        this.connecting = false;

        this.nodes = [];

        this.reconnectTimer = null;

        // ============================================================
        // Reconnect configuration
        // ============================================================

        this.reconnectDelay = 2000;
        this.maxReconnectDelay = 15000;

        // ============================================================
        // Framebuffer state
        // ============================================================

        this.frameSequence = 0;
        this.lastFrameTime = 0;

        this.frameReady = false;
        this.frameUpdating = false;

        this.frameWidth = 0;
        this.frameHeight = 0;

        this.frameBuffer = null;
        this.coverage = null;

        this.coveredPixels = 0;

        // ============================================================
        // Frame transaction
        // ============================================================

        this.transactionId = 0;

        this.activeTransaction = null;

        /*
         * Transaction:
         *
         * {
         *     id,
         *     startSequence,
         *     startTime,
         *     width,
         *     height,
         *     timeout,
         *     timer,
         *     callback
         * }
         */

        // ============================================================
        // Status
        // ============================================================

        this.statuses = {

            connected: {
                fill: 'green',
                shape: 'dot',
                text: 'connected'
            },

            connecting: {
                fill: 'yellow',
                shape: 'ring',
                text: 'connecting'
            },

            refreshing: {
                fill: 'blue',
                shape: 'dot',
                text: 'refreshing framebuffer'
            },

            ready: {
                fill: 'green',
                shape: 'dot',
                text: 'frame ready'
            },

            error: {
                fill: 'red',
                shape: 'ring',
                text: 'error'
            }

        };

        // ============================================================
        // Status helper
        // ============================================================

        this.updateStatus = function(status) {

            if (!status) {
                return;
            }

            this.nodes.forEach(function(n) {

                try {
                    n.status(status);
                }
                catch (e) {
                    // ignore
                }

            });

        };

        // ============================================================
        // Error helper
        // ============================================================

        this.reportError = function(message) {

            try {
                this.error(message);
            }
            catch (e) {
                // ignore
            }

        };

        // ============================================================
        // Cancel frame transaction
        // ============================================================

        this.cancelFrameTransaction = function(error) {

            var tx = this.activeTransaction;

            if (!tx) {
                return;
            }

            this.activeTransaction = null;

            if (tx.timer) {

                clearTimeout(tx.timer);

                tx.timer = null;

            }

            if (typeof tx.callback === 'function') {

                var cb = tx.callback;

                tx.callback = null;

                cb(
                    error ||
                    new Error('Framebuffer transaction cancelled')
                );

            }

        };

        // ============================================================
        // Framebuffer allocation
        // ============================================================

        this.allocateFramebuffer = function(width, height) {

            width = Number(width);
            height = Number(height);

            if (
                !width ||
                !height ||
                width < 1 ||
                height < 1
            ) {

                throw new Error(
                    'Invalid framebuffer size: ' +
                    width +
                    'x' +
                    height
                );

            }

            this.frameWidth = width;
            this.frameHeight = height;

            this.frameBuffer = Buffer.alloc(
                width * height * 4
            );

            /*
             * One byte per pixel.
             *
             * 0 = not received
             * 1 = received
             */

            this.coverage = Buffer.alloc(
                width * height
            );

            this.coveredPixels = 0;

            /*
             * Transparent black initially.
             */

            this.frameBuffer.fill(0);

        };

        // ============================================================
        // Reset framebuffer
        // ============================================================

        this.resetFramebuffer = function() {

            if (
                !this.frameWidth ||
                !this.frameHeight
            ) {
                return;
            }

            if (!this.frameBuffer) {

                this.allocateFramebuffer(
                    this.frameWidth,
                    this.frameHeight
                );

                return;

            }

            this.frameBuffer.fill(0);

            if (this.coverage) {
                this.coverage.fill(0);
            }

            this.coveredPixels = 0;

        };

        // ============================================================
        // Ensure framebuffer size
        // ============================================================

        this.ensureFramebuffer = function() {

            if (!this.rfb) {
                return false;
            }

            var width = Number(this.rfb.width);
            var height = Number(this.rfb.height);

            if (
                !width ||
                !height
            ) {
                return false;
            }

            if (
                width !== this.frameWidth ||
                height !== this.frameHeight ||
                !this.frameBuffer ||
                !this.coverage
            ) {

                this.allocateFramebuffer(
                    width,
                    height
                );

            }

            return true;

        };

        // ============================================================
        // Mark coverage
        // ============================================================

        this.markCoverage = function(
            x,
            y,
            width,
            height
        ) {

            if (!this.coverage) {
                return;
            }

            var fbWidth = this.frameWidth;
            var fbHeight = this.frameHeight;

            var x1 = Math.max(0, x);
            var y1 = Math.max(0, y);

            var x2 = Math.min(
                fbWidth,
                x + width
            );

            var y2 = Math.min(
                fbHeight,
                y + height
            );

            if (
                x2 <= x1 ||
                y2 <= y1
            ) {
                return;
            }

            for (
                var yy = y1;
                yy < y2;
                yy++
            ) {

                var offset =
                    yy * fbWidth +
                    x1;

                for (
                    var xx = x1;
                    xx < x2;
                    xx++
                ) {

                    if (
                        this.coverage[offset] === 0
                    ) {

                        this.coverage[offset] = 1;

                        this.coveredPixels++;

                    }

                    offset++;

                }

            }

        };

        // ============================================================
        // CopyRect
        // ============================================================

        this.copyRectToFramebuffer = function(rect) {

            if (
                !this.frameBuffer ||
                !rect ||
                !rect.src
            ) {
                return false;
            }

            var width = Number(rect.width);
            var height = Number(rect.height);

            var srcX = Number(rect.src.x);
            var srcY = Number(rect.src.y);

            var dstX = Number(rect.x);
            var dstY = Number(rect.y);

            if (
                width <= 0 ||
                height <= 0
            ) {
                return true;
            }

            var fbWidth = this.frameWidth;
            var fbHeight = this.frameHeight;

            /*
             * Copy row by row.
             *
             * Buffer.copy() is used so overlapping regions
             * are handled safely.
             */

            var rows = [];

            for (
                var y = 0;
                y < height;
                y++
            ) {

                var sy = srcY + y;
                var dy = dstY + y;

                if (
                    sy < 0 ||
                    sy >= fbHeight ||
                    dy < 0 ||
                    dy >= fbHeight
                ) {
                    continue;
                }

                var sx = Math.max(0, srcX);
                var dx = Math.max(0, dstX);

                var offsetAdjust =
                    Math.max(0, -srcX);

                var destinationAdjust =
                    Math.max(0, -dstX);

                var copyWidth = Math.min(
                    width - offsetAdjust,
                    fbWidth - dx
                );

                if (copyWidth <= 0) {
                    continue;
                }

                var srcOffset =
                    (
                        sy * fbWidth +
                        sx
                    ) * 4;

                var dstOffset =
                    (
                        dy * fbWidth +
                        dx
                    ) * 4;

                rows.push({
                    srcOffset: srcOffset,
                    dstOffset: dstOffset,
                    length: copyWidth * 4
                });

            }

            /*
             * Copy through temporary buffers.
             *
             * This avoids corruption if source and destination
             * overlap.
             */

            var temp = [];

            rows.forEach(function(row) {

                temp.push(
                    Buffer.from(
                        this.frameBuffer.slice(
                            row.srcOffset,
                            row.srcOffset +
                            row.length
                        )
                    )
                );

            }, this);

            rows.forEach(function(row, index) {

                temp[index].copy(
                    this.frameBuffer,
                    row.dstOffset
                );

            }, this);

            this.markCoverage(
                dstX,
                dstY,
                width,
                height
            );

            return true;

        };

        // ============================================================
        // RAW rectangle → framebuffer
        // ============================================================

        this.writeRawRect = function(rect) {

            if (
                !rect ||
                !rect.data ||
                !this.frameBuffer
            ) {
                return false;
            }

            var width = Number(rect.width);
            var height = Number(rect.height);

            var x = Number(rect.x);
            var y = Number(rect.y);

            if (
                width <= 0 ||
                height <= 0
            ) {
                return false;
            }

            var data = rect.data;

            /*
             * rfb2 0.2.x normally provides 32-bit pixel data
             * for the common VNC configurations used by this node.
             *
             * Existing project code assumes:
             *
             *   B G R X
             *
             * Therefore retain that behaviour for 4-byte pixels.
             *
             * 3-byte BGR is also supported.
             */

            var bytesPerPixel =
                Math.floor(
                    data.length /
                    (width * height)
                );

            if (
                bytesPerPixel !== 4 &&
                bytesPerPixel !== 3 &&
                bytesPerPixel !== 2
            ) {

                throw new Error(
                    'Unsupported RAW pixel size: ' +
                    bytesPerPixel +
                    ' bytes/pixel'
                );

            }

            var fbWidth = this.frameWidth;
            var fbHeight = this.frameHeight;

            for (
                var py = 0;
                py < height;
                py++
            ) {

                var fy = y + py;

                if (
                    fy < 0 ||
                    fy >= fbHeight
                ) {
                    continue;
                }

                for (
                    var px = 0;
                    px < width;
                    px++
                ) {

                    var fx = x + px;

                    if (
                        fx < 0 ||
                        fx >= fbWidth
                    ) {
                        continue;
                    }

                    var src =
                        (
                            py * width +
                            px
                        ) * bytesPerPixel;

                    var dst =
                        (
                            fy * fbWidth +
                            fx
                        ) * 4;

                    var red;
                    var green;
                    var blue;

                    if (bytesPerPixel === 4) {

                        /*
                         * Existing rfb2/node-red-contrib-vnc
                         * behaviour:
                         *
                         * data[0] = B
                         * data[1] = G
                         * data[2] = R
                         * data[3] = X/A
                         */

                        blue = data[src];
                        green = data[src + 1];
                        red = data[src + 2];

                    }
                    else if (bytesPerPixel === 3) {

                        blue = data[src];
                        green = data[src + 1];
                        red = data[src + 2];

                    }
                    else {

                        /*
                         * Common 16-bit RGB565 fallback.
                         */

                        var value =
                            data[src] |
                            (
                                data[src + 1] << 8
                            );

                        red =
                            ((value >> 11) & 0x1f) * 255 / 31;

                        green =
                            ((value >> 5) & 0x3f) * 255 / 63;

                        blue =
                            (value & 0x1f) * 255 / 31;

                    }

                    this.frameBuffer[dst] =
                        Math.max(
                            0,
                            Math.min(
                                255,
                                Math.round(red)
                            )
                        );

                    this.frameBuffer[dst + 1] =
                        Math.max(
                            0,
                            Math.min(
                                255,
                                Math.round(green)
                            )
                        );

                    this.frameBuffer[dst + 2] =
                        Math.max(
                            0,
                            Math.min(
                                255,
                                Math.round(blue)
                            )
                        );

                    this.frameBuffer[dst + 3] = 255;

                }

            }

            this.markCoverage(
                x,
                y,
                width,
                height
            );

            return true;

        };

        // ============================================================
        // Check framebuffer coverage
        // ============================================================

        this.isFramebufferComplete = function() {

            if (
                !this.frameBuffer ||
                !this.coverage
            ) {
                return false;
            }

            var total =
                this.frameWidth *
                this.frameHeight;

            return (
                total > 0 &&
                this.coveredPixels >= total
            );

        };

        // ============================================================
        // Get framebuffer
        // ============================================================

        this.getFramebuffer = function() {

            if (
                !this.frameBuffer ||
                !this.frameWidth ||
                !this.frameHeight
            ) {
                return null;
            }

            return {
                data: Buffer.from(
                    this.frameBuffer
                ),

                width: this.frameWidth,

                height: this.frameHeight,

                sequence: this.frameSequence,

                timestamp: this.lastFrameTime,

                complete:
                    this.isFramebufferComplete(),

                coveredPixels:
                    this.coveredPixels,

                totalPixels:
                    this.frameWidth *
                    this.frameHeight
            };

        };

        // ============================================================
        // Handle framebuffer rectangle
        // ============================================================

        this.handleRect = function(rect) {

            if (!this.rfb || !rect) {
                return;
            }

            /*
             * Ensure framebuffer exists.
             */

            if (!this.ensureFramebuffer()) {
                return;
            }

            var encoding =
                Number(rect.encoding);

            var rawEncoding =
                rfb.encodings &&
                rfb.encodings.raw !== undefined
                    ? rfb.encodings.raw
                    : 0;

            var copyEncoding =
                rfb.encodings &&
                rfb.encodings.copyRect !== undefined
                    ? rfb.encodings.copyRect
                    : 1;

            try {

                if (
                    encoding === rawEncoding
                ) {

                    this.writeRawRect(rect);

                }
                else if (
                    encoding === copyEncoding
                ) {

                    this.copyRectToFramebuffer(rect);

                }
                else {

                    /*
                     * rfb2 0.2.2 does not fully implement
                     * modern encodings.
                     *
                     * Do not falsely mark unsupported
                     * rectangles as valid framebuffer data.
                     */

                    this.reportError(
                        'Unsupported VNC encoding: ' +
                        encoding
                    );

                    return;

                }

                this.frameSequence++;

                this.lastFrameTime =
                    Date.now();

                /*
                 * A rectangle has arrived.
                 */

                if (
                    this.activeTransaction &&
                    this.isFramebufferComplete()
                ) {

                    this.completeFrameTransaction();

                }

                else {

                    this.frameReady =
                        this.isFramebufferComplete();

                }

            }
            catch (err) {

                this.reportError(
                    'Framebuffer RECT error: ' +
                    err.message
                );

                if (
                    this.activeTransaction
                ) {

                    this.failFrameTransaction(
                        err
                    );

                }

            }

        };

        // ============================================================
        // Complete transaction
        // ============================================================

        this.completeFrameTransaction =
            function() {

                var tx =
                    this.activeTransaction;

                if (!tx) {
                    return;
                }

                this.activeTransaction = null;

                if (tx.timer) {

                    clearTimeout(tx.timer);

                    tx.timer = null;

                }

                this.frameReady = true;
                this.frameUpdating = false;

                this.updateStatus(
                    this.statuses.ready
                );

                var frame =
                    this.getFramebuffer();

                if (
                    typeof tx.callback ===
                    'function'
                ) {

                    var cb = tx.callback;

                    tx.callback = null;

                    cb(
                        null,
                        frame
                    );

                }

            };

        // ============================================================
        // Fail transaction
        // ============================================================

        this.failFrameTransaction =
            function(error) {

                var tx =
                    this.activeTransaction;

                if (!tx) {
                    return;
                }

                this.activeTransaction = null;

                if (tx.timer) {

                    clearTimeout(
                        tx.timer
                    );

                    tx.timer = null;

                }

                this.frameUpdating = false;

                if (
                    typeof tx.callback ===
                    'function'
                ) {

                    var cb = tx.callback;

                    tx.callback = null;

                    cb(
                        error ||
                        new Error(
                            'Framebuffer transaction failed'
                        )
                    );

                }

            };

        // ============================================================
        // Request FULL framebuffer
        // ============================================================

        this.requestFullFramebuffer =
            function() {

                var self = this;

                if (
                    !self.rfb ||
                    !self.connected
                ) {
                    return false;
                }

                if (
                    !self.rfb.width ||
                    !self.rfb.height
                ) {
                    return false;
                }

                try {

                    self.ensureFramebuffer();

                    /*
                     * This is the critical part.
                     *
                     * incremental = false
                     *
                     * means request a complete update.
                     */

                    self.rfb.requestUpdate(
                        false,
                        0,
                        0,
                        self.rfb.width,
                        self.rfb.height
                    );

                    return true;

                }
                catch (err) {

                    self.reportError(
                        'Framebuffer request error: ' +
                        err.message
                    );

                    return false;

                }

            };

        // ============================================================
        // Start Frame Transaction
        // ============================================================

        this.captureFrame =
            function(timeout, callback) {

                var self = this;

                timeout =
                    Number(timeout) || 5000;

                callback =
                    callback ||
                    function() {};

                if (
                    !self.connected ||
                    !self.rfb
                ) {

                    callback(
                        new Error(
                            'VNC is not connected'
                        )
                    );

                    return;

                }

                /*
                 * Do not allow overlapping transactions.
                 */

                if (
                    self.activeTransaction
                ) {

                    callback(
                        new Error(
                            'Framebuffer capture already in progress'
                        )
                    );

                    return;

                }

                if (
                    !self.ensureFramebuffer()
                ) {

                    callback(
                        new Error(
                            'Framebuffer size unavailable'
                        )
                    );

                    return;

                }

                /*
                 * New transaction.
                 */

                var id =
                    ++self.transactionId;

                /*
                 * Clear previous coverage.
                 *
                 * This is critical:
                 *
                 * old framebuffer data is NOT considered
                 * part of the new frame transaction.
                 */

                self.resetFramebuffer();

                self.frameReady = false;
                self.frameUpdating = true;

                var tx = {

                    id: id,

                    startSequence:
                        self.frameSequence,

                    startTime:
                        Date.now(),

                    width:
                        self.frameWidth,

                    height:
                        self.frameHeight,

                    timeout:
                        timeout,

                    timer: null,

                    callback:
                        callback

                };

                self.activeTransaction =
                    tx;

                self.updateStatus(
                    self.statuses.refreshing
                );

                tx.timer =
                    setTimeout(
                        function() {

                            if (
                                self.activeTransaction !==
                                tx
                            ) {
                                return;
                            }

                            self.failFrameTransaction(
                                new Error(
                                    'Framebuffer transaction timeout'
                                )
                            );

                        },
                        timeout
                    );

                /*
                 * Request a NON-INCREMENTAL full frame.
                 */

                if (
                    !self.requestFullFramebuffer()
                ) {

                    self.failFrameTransaction(
                        new Error(
                            'Unable to request full framebuffer'
                        )
                    );

                }

            };

        // ============================================================
        // waitForFreshFrame
        //
        // Backward compatible API
        // ============================================================

        this.waitForFreshFrame =
            function(timeout, callback) {

                this.captureFrame(
                    timeout,
                    callback
                );

            };

        // ============================================================
        // getFreshFrame
        //
        // Backward compatible API
        // ============================================================

        this.getFreshFrame =
            function(callback) {

                this.captureFrame(
                    5000,
                    callback
                );

            };

        // ============================================================
        // Incremental framebuffer
        // ============================================================

        this.requestIncrementalFramebuffer =
            function() {

                if (
                    !this.rfb ||
                    !this.connected
                ) {
                    return false;
                }

                try {

                    this.rfb.requestUpdate(
                        true,
                        0,
                        0,
                        this.rfb.width,
                        this.rfb.height
                    );

                    return true;

                }
                catch (err) {

                    return false;

                }

            };

        // ============================================================
        // Cleanup RFB
        // ============================================================

        this.cleanupRfb =
            function() {

                this.cancelFrameTransaction(
                    new Error(
                        'VNC connection closed'
                    )
                );

                if (!this.rfb) {

                    this.connected = false;
                    this.connecting = false;

                    return;

                }

                var oldRfb =
                    this.rfb;

                this.rfb = null;

                this.connected = false;
                this.connecting = false;

                try {
                    oldRfb.removeAllListeners();
                }
                catch (e) {}

                try {
                    if (
                        typeof oldRfb.cleanup ===
                        'function'
                    ) {
                        oldRfb.cleanup();
                    }
                }
                catch (e) {}

                try {
                    if (
                        typeof oldRfb.end ===
                        'function'
                    ) {
                        oldRfb.end();
                    }
                }
                catch (e) {}

                this.frameReady = false;
                this.frameUpdating = false;

            };

        // ============================================================
        // Explicit disconnect
        // ============================================================

        this.disconnect =
            function() {

                this.cancelReconnect();

                this.cleanupRfb();

                this.updateStatus({
                    fill: 'grey',
                    shape: 'ring',
                    text: 'disconnected'
                });

            };

        // ============================================================
        // Cancel reconnect
        // ============================================================

        this.cancelReconnect =
            function() {

                if (
                    this.reconnectTimer
                ) {

                    clearTimeout(
                        this.reconnectTimer
                    );

                    this.reconnectTimer = null;

                }

            };

        // ============================================================
        // Schedule reconnect
        // ============================================================

        this.scheduleReconnect =
            function() {

                var self = this;

                if (
                    self.reconnectTimer ||
                    self.connecting
                ) {
                    return;
                }

                self.reconnectTimer =
                    setTimeout(
                        function() {

                            self.reconnectTimer =
                                null;

                            self.connect(
                                function() {}
                            );

                        },
                        self.reconnectDelay
                    );

            };

        // ============================================================
        // Connect
        // ============================================================

        this.connect =
            function(callback) {

                var self = this;

                callback =
                    callback ||
                    function() {};

                if (self.connecting) {

                    return callback(
                        new Error(
                            'Connection attempt already in progress'
                        )
                    );

                }

                if (
                    self.connected &&
                    self.rfb
                ) {

                    return callback();

                }

                self.cancelReconnect();

                self.cleanupRfb();

                self.connecting = true;

                self.frameReady = false;

                self.updateStatus(
                    self.statuses.connecting
                );

                var connection;

                try {

                    connection =
                        rfb.createConnection({

                            host:
                                self.host,

                            port:
                                self.port,

                            password:
                                self.password

                        });

                    self.rfb =
                        connection;

                }
                catch (err) {

                    self.connecting = false;

                    self.updateStatus(
                        self.statuses.error
                    );

                    self.scheduleReconnect();

                    callback(err);

                    return;

                }

                // ====================================================
                // CONNECT
                // ====================================================

                connection.on(
                    'connect',
                    function() {

                        self.connected =
                            true;

                        self.connecting =
                            false;

                        self.frameSequence =
                            0;

                        self.lastFrameTime =
                            0;

                        self.frameReady =
                            false;

                        self.frameUpdating =
                            false;

                        /*
                         * Allocate framebuffer.
                         */

                        try {

                            self.allocateFramebuffer(
                                connection.width,
                                connection.height
                            );

                        }
                        catch (err) {

                            self.reportError(
                                'Framebuffer allocation failed: ' +
                                err.message
                            );

                        }

                        self.updateStatus(
                            self.statuses.connected
                        );

                        self.clipboardNodes(
                            'register'
                        );

                        /*
                         * Initial full framebuffer request.
                         *
                         * This is not used as the screenshot
                         * transaction. It simply primes the
                         * framebuffer.
                         */

                        setTimeout(
                            function() {

                                if (
                                    self.connected &&
                                    self.rfb
                                ) {

                                    self.requestFullFramebuffer();

                                }

                            },
                            100
                        );

                        callback();

                    }
                );

                // ====================================================
                // RECT
                // ====================================================

                connection.on(
                    'rect',
                    function(rect) {

                        self.handleRect(
                            rect
                        );

                    }
                );

                // ====================================================
                // RESIZE
                // ====================================================

                connection.on(
                    'resize',
                    function(rect) {

                        try {

                            var width =
                                Number(
                                    rect.width
                                );

                            var height =
                                Number(
                                    rect.height
                                );

                            if (
                                width > 0 &&
                                height > 0
                            ) {

                                self.allocateFramebuffer(
                                    width,
                                    height
                                );

                            }

                        }
                        catch (err) {

                            self.reportError(
                                'Framebuffer resize error: ' +
                                err.message
                            );

                        }

                        self.frameReady =
                            false;

                        setTimeout(
                            function() {

                                if (
                                    self.connected &&
                                    self.rfb
                                ) {

                                    self.requestFullFramebuffer();

                                }

                            },
                            100
                        );

                    }
                );

                // ====================================================
                // ERROR
                // ====================================================

                connection.on(
                    'error',
                    function(err) {

                        self.connected =
                            false;

                        self.connecting =
                            false;

                        self.frameReady =
                            false;

                        self.frameUpdating =
                            false;

                        self.cancelFrameTransaction(
                            new Error(
                                'VNC connection error'
                            )
                        );

                        self.clipboardNodes(
                            'unregister'
                        );

                        self.updateStatus(
                            self.statuses.error
                        );

                        var message =
                            err &&
                            err.message
                                ? err.message
                                : String(err);

                        self.reportError(
                            'VNC error: ' +
                            message
                        );

                        /*
                         * Only notify callback if this was
                         * the active connection attempt.
                         */

                        try {

                            callback(err);

                        }
                        catch (e) {}

                        self.scheduleReconnect();

                    }
                );

                // ====================================================
                // CLOSE
                // ====================================================

                connection.on(
                    'close',
                    function() {

                        self.connected =
                            false;

                        self.connecting =
                            false;

                        self.frameReady =
                            false;

                        self.frameUpdating =
                            false;

                        self.cancelFrameTransaction(
                            new Error(
                                'VNC connection closed by remote'
                            )
                        );

                        self.clipboardNodes(
                            'unregister'
                        );

                        self.updateStatus(
                            self.statuses.error
                        );

                        self.reportError(
                            'VNC connection closed by remote'
                        );

                        self.scheduleReconnect();

                    }
                );

            };

        // ============================================================
        // Perform
        // ============================================================

        this.perform =
            function(callback) {

                var self = this;

                callback =
                    callback ||
                    function() {};

                if (
                    self.connected &&
                    self.rfb
                ) {

                    callback();

                    return;

                }

                if (self.connecting) {

                    /*
                     * Instead of immediately failing, wait for
                     * the existing connection attempt.
                     */

                    var start =
                        Date.now();

                    var timeout =
                        10000;

                    function waitConnection() {

                        if (
                            self.connected &&
                            self.rfb
                        ) {

                            callback();

                            return;

                        }

                        if (
                            !self.connecting
                        ) {

                            callback(
                                new Error(
                                    'VNC connection failed'
                                )
                            );

                            return;

                        }

                        if (
                            Date.now() -
                            start >=
                            timeout
                        ) {

                            callback(
                                new Error(
                                    'VNC connection timeout'
                                )
                            );

                            return;

                        }

                        setTimeout(
                            waitConnection,
                            100
                        );

                    }

                    waitConnection();

                    return;

                }

                self.connect(
                    callback
                );

            };

        // ============================================================
        // Clipboard
        // ============================================================

        this.clipboardNodes =
            function(func) {

                switch(func) {

                    case 'register':

                        this.nodes.forEach(
                            function(n) {

                                if (
                                    n.type ===
                                        'clipboard' &&
                                    !n.registered
                                ) {

                                    try {

                                        n.register();

                                    }
                                    catch (e) {}

                                }

                            }
                        );

                        break;

                    case 'unregister':

                        this.nodes.forEach(
                            function(n) {

                                if (
                                    n.type ===
                                    'clipboard'
                                ) {

                                    n.registered =
                                        false;

                                }

                            }
                        );

                        break;

                }

            };

        // ============================================================
        // Node-RED close
        // ============================================================

        this.on(
            'close',
            function(removed, done) {

                node.cancelReconnect();

                node.cancelFrameTransaction(
                    new Error(
                        'Node closed'
                    )
                );

                node.clipboardNodes(
                    'unregister'
                );

                node.cleanupRfb();

                if (
                    typeof done ===
                    'function'
                ) {

                    done();

                }

            }
        );

        // ============================================================
        // Initial connection
        // ============================================================

        this.connect(
            function(err) {

                if (err) {

                    node.reportError(
                        'Initial VNC connection failed: ' +
                        err.message
                    );

                }

            }
        );

    }

    // ================================================================
    // Register Node-RED node
    // ================================================================

    RED.nodes.registerType(
        'vnc-client',
        vncClientNode
    );

};;
