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
        // Runtime state
        // ============================================================

        this.rfb = null;

        this.connected = false;
        this.connecting = false;

        this.nodes = [];

        this.reconnectTimer = null;
        this.frameTimer = null;

        // framebuffer �狀態
        this.frameSequence = 0;
        this.lastFrameTime = 0;
        this.frameUpdating = false;

        // 是否已取得至少一個 framebuffer update
        this.frameReady = false;

        // 是否正在等待 fresh frame
        this.waitingForFrame = false;

        // reconnect parameters
        this.reconnectDelay = 2000;
        this.maxReconnectDelay = 15000;

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
        // Update Node-RED node status
        // ============================================================

        this.updateStatus = function(status) {

            if (!status) return;

            this.nodes.forEach(function(n) {

                try {
                    n.status(status);
                }
                catch (e) {
                    // ignore status errors
                }

            });

        };

        // ============================================================
        // Cleanup RFB connection
        // ============================================================

        this.cleanupRfb = function() {

            if (!this.rfb) {
                return;
            }

            try {
                this.rfb.removeAllListeners();
            }
            catch (e) {
                // ignore
            }

            try {
                this.rfb.cleanup();
            }
            catch (e) {
                // ignore
            }

            try {
                this.rfb.end();
            }
            catch (e) {
                // ignore
            }

            this.rfb = null;

            this.connected = false;
            this.connecting = false;
            this.frameReady = false;
            this.frameUpdating = false;
            this.waitingForFrame = false;
        };

        // ============================================================
        // Cancel reconnect timer
        // ============================================================

        this.cancelReconnect = function() {

            if (this.reconnectTimer) {

                clearTimeout(this.reconnectTimer);

                this.reconnectTimer = null;
            }

        };

        // ============================================================
        // Automatic reconnect
        // ============================================================

        this.scheduleReconnect = function() {

            var self = this;

            if (self.reconnectTimer) {
                return;
            }

            if (self.connecting) {
                return;
            }

            self.reconnectTimer = setTimeout(function() {

                self.reconnectTimer = null;

                self.connect(function() {});

            }, self.reconnectDelay);

        };

        // ============================================================
        // Request FULL framebuffer
        //
        // incremental = false
        //
        // 會要求 VNC Server �� 傳送完整畫面
        // ============================================================

        this.requestFullFramebuffer = function() {

            var self = this;

            if (!self.rfb || !self.connected) {

                return false;
            }

            if (!self.rfb.width || !self.rfb.height) {

                return false;
            }

            try {

                self.frameReady = false;

                self.frameUpdating = true;

                self.updateStatus(
                    self.statuses.refreshing
                );



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

                self.error(
                    'Framebuffer request error: ' +
                    err.message
                );

                return false;
            }

        };

        // ============================================================
        // Request incremental framebuffer
        //
        // 用於正常保持畫面更新
        // ============================================================

        this.requestIncrementalFramebuffer = function() {

            if (!this.rfb || !this.connected) {
                return false;
            }

            if (!this.rfb.width || !this.rfb.height) {
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
        // Framebuffer RECT received
        //
        // rfb2 會在收到 framebuffer rectangle 時�觸發 rect
        // ============================================================

        this.handleRect = function(rect) {

            this.frameSequence++;

            this.lastFrameTime = Date.now();

            this.frameReady = true;

            this.frameUpdating = false;


            if (this.waitingForFrame) {

                this.waitingForFrame = false;

                if (this.frameTimer) {

                    clearTimeout(this.frameTimer);

                    this.frameTimer = null;

                }

            }

            this.updateStatus(
                this.statuses.ready
            );

        };

        // ============================================================
        // Wait for fresh framebuffer
        //
        // callback(error, frameInfo)
        //
        // timeout � 預設 5000ms
        // ============================================================

        this.waitForFreshFrame = function(timeout, callback) {

            var self = this;

            timeout = Number(timeout) || 5000;

            callback = callback || function() {};

            if (!self.connected || !self.rfb) {

                return callback(
                    new Error('VNC is not connected')
                );

            }

            var startSequence = self.frameSequence;

            self.waitingForFrame = true;


            if (!self.requestFullFramebuffer()) {

                self.waitingForFrame = false;

                return callback(
                    new Error(
                        'Unable to request framebuffer'
                    )
                );

            }

            var startTime = Date.now();

            function checkFrame() {


                if (self.frameSequence > startSequence) {

                    self.waitingForFrame = false;

                    return callback(null, {

                        sequence: self.frameSequence,

                        timestamp: self.lastFrameTime,

                        elapsed:
                            Date.now() - startTime

                    });

                }

                if (!self.connected) {

                    self.waitingForFrame = false;

                    return callback(
                        new Error(
                            'VNC disconnected while waiting for frame'
                        )
                    );

                }

                if (
                    Date.now() - startTime >=
                    timeout
                ) {

                    self.waitingForFrame = false;

                    return callback(
                        new Error(
                            'Framebuffer update timeout'
                        )
                    );

                }

                self.frameTimer = setTimeout(
                    checkFrame,
                    50
                );

            }

            checkFrame();

        };

        // ============================================================
        // Connect
        // ============================================================

        this.connect = function(callback) {

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

            self.cancelReconnect();


            self.cleanupRfb();

            self.connected = false;

            self.connecting = true;

            self.frameReady = false;

            self.updateStatus(
                self.statuses.connecting
            );

            try {

                self.rfb = rfb.createConnection({

                    host: self.host,

                    port: self.port,

                    password: self.password

                });

            }
            catch (err) {

                self.connecting = false;

                self.updateStatus(
                    self.statuses.error
                );

                self.scheduleReconnect();

                return callback(err);

            }

            // ========================================================
            // CONNECT
            // ========================================================

            self.rfb.on('connect', function() {

                self.connected = true;

                self.connecting = false;


                self.frameSequence = 0;

                self.lastFrameTime = 0;

                self.frameReady = false;

                self.frameUpdating = false;

                self.updateStatus(
                    self.statuses.connected
                );


                self.clipboardNodes(
                    'register'
                );


                setTimeout(function() {

                    if (
                        self.connected &&
                        self.rfb
                    ) {

                        self.requestFullFramebuffer();

                    }

                }, 100);


                callback();

            });

            // ========================================================
            // RECT / FRAMEBUFFER UPDATE
            // ========================================================

            self.rfb.on('rect', function(rect) {

                self.handleRect(rect);

            });

            // ========================================================
            // RESIZE
            // ========================================================

            self.rfb.on('resize', function(rect) {


                self.frameReady = false;

                setTimeout(function() {

                    if (
                        self.connected &&
                        self.rfb
                    ) {

                        self.requestFullFramebuffer();

                    }

                }, 100);

            });

            // ========================================================
            // ERROR
            // ========================================================

            self.rfb.on('error', function(err) {

                self.connecting = false;

                self.connected = false;

                self.frameReady = false;

                self.frameUpdating = false;

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

                self.error(
                    'VNC error: ' + message
                );


                try {
                    callback(err);
                }
                catch (e) {}


                self.scheduleReconnect();

            });

            // ========================================================
            // CLOSE
            // ========================================================

            self.rfb.on('close', function() {

                self.connected = false;

                self.connecting = false;

                self.frameReady = false;

                self.frameUpdating = false;

                self.clipboardNodes(
                    'unregister'
                );

                self.updateStatus(
                    self.statuses.error
                );

                self.error(
                    'VNC connection closed by remote'
                );


                self.scheduleReconnect();

            });

        };

        // ============================================================
        // Clipboard nodes
        // ============================================================

        this.clipboardNodes = function(func) {

            switch(func) {

                case 'register':

                    this.nodes.forEach(function(n) {

                        if (
                            n.type === 'clipboard' &&
                            !n.registered
                        ) {

                            try {

                                n.register();

                            }
                            catch (e) {}

                        }

                    });

                    break;

                case 'unregister':

                    this.nodes.forEach(function(n) {

                        if (
                            n.type === 'clipboard'
                        ) {

                            n.registered = false;

                        }

                    });

                    break;

            }

        };

        // ============================================================
        // Perform
        // ============================================================

        this.perform = function(callback) {

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

                return callback(
                    'Error: Connection attempt already in progress'
                );

            }

            self.connect(callback);

        };

        // ============================================================
        // Public API
        //
        // 截�圖節點可以呼叫：
        //
        // node.waitForFreshFrame(5000, function(err, info) {
        //
        //     // 最新 framebuffer � 已收到
        //     // 這時才�執行 screenshot
        //
        // });
        // ============================================================

        this.getFreshFrame = function(callback) {

            this.waitForFreshFrame(
                5000,
                callback
            );

        };

        // ============================================================
        // Node-RED close
        // ============================================================

        this.on('close', function(removed, done) {

            node.cancelReconnect();

            if (node.frameTimer) {

                clearTimeout(
                    node.frameTimer
                );

                node.frameTimer = null;

            }

            node.clipboardNodes(
                'unregister'
            );

            node.cleanupRfb();

            if (typeof done === 'function') {
                done();
            }

        });

        // ============================================================
        // Initial connection
        // ============================================================

        this.connect(function(err) {

            if (err) {

                node.error(
                    'Initial VNC connection failed: ' +
                    err.message
                );

            }

        });

    }

    // ================================================================
    // Register Node-RED node
    // ================================================================

    RED.nodes.registerType(
        'vnc-client',
        vncClientNode
    );

};
