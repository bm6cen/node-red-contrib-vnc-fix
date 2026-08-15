var Jimp = require('jimp');

module.exports = function(RED) {

    function screenshotNode(config) {

        RED.nodes.createNode(
            this,
            config
        );

        var node = this;

        // ============================================================
        // VNC client
        // ============================================================

        this.client =
            RED.nodes.getNode(
                config.client
            );

        if (!this.client) {

            node.error(
                'Missing VNC client configuration'
            );

            return;

        }

        if (!this.client.nodes) {
            this.client.nodes = [];
        }

        this.client.nodes.push(
            this
        );

        // ============================================================
        // Configuration
        // ============================================================

        var disconnectTimer = null;

        var busy = false;

        var wakeRetryCount = 0;

        var reconnectRetryCount = 0;

        var MAX_WAKE_RETRIES = 3;

        var MAX_RECONNECT_RETRIES = 2;

        var WAKE_DELAY = 1500;

        var CAPTURE_TIMEOUT = 6000;

        var BLACK_THRESHOLD = 0.90;

        var BLACK_PIXEL_THRESHOLD = 12;

        // ============================================================
        // Input
        // ============================================================

        node.on(
            'input',
            function(msg) {

                if (busy) {

                    node.warn(
                        'Screenshot already in progress - request ignored'
                    );

                    return;

                }

                if (!node.client) {

                    node.error(
                        'Missing VNC client configuration'
                    );

                    return;

                }

                busy = true;

                wakeRetryCount = 0;

                reconnectRetryCount = 0;

                node.status({
                    fill: 'yellow',
                    shape: 'dot',
                    text: 'starting capture'
                });

                captureAndSend(
                    msg
                );

            }
        );

        // ============================================================
        // Main capture
        // ============================================================

        function captureAndSend(msg) {

            if (!node.client) {

                finishError(
                    'VNC client unavailable'
                );

                return;

            }

            node.status({
                fill: 'yellow',
                shape: 'dot',
                text: 'connecting'
            });

            node.client.perform(
                function(err) {

                    if (err) {

                        handleConnectionError(
                            msg,
                            err
                        );

                        return;

                    }

                    /*
                     * At this point TCP/VNC connection exists.
                     *
                     * Wake the HMI before requesting the
                     * framebuffer.
                     */

                    wakeScreen(
                        function(wakeErr) {

                            if (wakeErr) {

                                finishError(
                                    'Wake sequence failed: ' +
                                    wakeErr.message
                                );

                                return;

                            }

                            /*
                             * Give the HMI/VNC server time to
                             * repaint after wake-up.
                             */

                            setTimeout(
                                function() {

                                    captureFreshFramebuffer(
                                        msg
                                    );

                                },
                                WAKE_DELAY
                            );

                        }
                    );

                }
            );

        }

        // ============================================================
        // Wake HMI
        // ============================================================

        function wakeScreen(callback) {

            callback =
                callback ||
                function() {};

            if (
                !node.client ||
                !node.client.rfb
            ) {

                callback(
                    new Error(
                        'VNC connection unavailable'
                    )
                );

                return;

            }

            var r =
                node.client.rfb;

            try {

                /*
                 * Wake sequence:
                 *
                 * move 0,0
                 * move 1,1
                 * click
                 * click
                 */

                r.pointerEvent(
                    0,
                    0,
                    0
                );

                setTimeout(
                    function() {

                        if (
                            !node.client ||
                            !node.client.rfb
                        ) {

                            callback(
                                new Error(
                                    'VNC disconnected during wake'
                                )
                            );

                            return;

                        }

                        node.client.rfb.pointerEvent(
                            1,
                            1,
                            0
                        );

                        setTimeout(
                            function() {

                                if (
                                    !node.client ||
                                    !node.client.rfb
                                ) {

                                    callback(
                                        new Error(
                                            'VNC disconnected during wake'
                                        )
                                    );

                                    return;

                                }

                                node.client.rfb.pointerEvent(
                                    0,
                                    0,
                                    1
                                );

                                setTimeout(
                                    function() {

                                        if (
                                            !node.client ||
                                            !node.client.rfb
                                        ) {

                                            callback(
                                                new Error(
                                                    'VNC disconnected during wake'
                                                )
                                            );

                                            return;

                                        }

                                        node.client.rfb.pointerEvent(
                                            0,
                                            0,
                                            0
                                        );

                                        setTimeout(
                                            function() {

                                                if (
                                                    !node.client ||
                                                    !node.client.rfb
                                                ) {

                                                    callback(
                                                        new Error(
                                                            'VNC disconnected during wake'
                                                        )
                                                    );

                                                    return;

                                                }

                                                node.client.rfb.pointerEvent(
                                                    0,
                                                    0,
                                                    1
                                                );

                                                setTimeout(
                                                    function() {

                                                        if (
                                                            !node.client ||
                                                            !node.client.rfb
                                                        ) {

                                                            callback(
                                                                new Error(
                                                                    'VNC disconnected during wake'
                                                                )
                                                            );

                                                            return;

                                                        }

                                                        node.client.rfb.pointerEvent(
                                                            0,
                                                            0,
                                                            0
                                                        );

                                                        callback();

                                                    },
                                                    50
                                                );

                                            },
                                            50
                                        );

                                    },
                                    50
                                );

                            },
                            50
                        );

                    },
                    50
                );

            }
            catch (err) {

                callback(err);

            }

        }

        // ============================================================
        // Capture fresh framebuffer
        // ============================================================

        function captureFreshFramebuffer(
            msg
        ) {

            if (
                !node.client ||
                !node.client.connected
            ) {

                handleConnectionError(
                    msg,
                    new Error(
                        'VNC disconnected before framebuffer capture'
                    )
                );

                return;

            }

            node.status({
                fill: 'blue',
                shape: 'dot',
                text: 'requesting full framebuffer'
            });

            /*
             * IMPORTANT:
             *
             * captureFrame() performs:
             *
             * 1. reset framebuffer
             * 2. reset coverage
             * 3. requestUpdate(false)
             * 4. collect ALL RECTs
             * 5. wait until coverage = 100%
             * 6. return complete framebuffer
             */

            node.client.captureFrame(
                CAPTURE_TIMEOUT,
                function(
                    err,
                    frame
                ) {

                    if (err) {

                        handleFrameError(
                            msg,
                            err
                        );

                        return;

                    }

                    if (!frame) {

                        handleFrameError(
                            msg,
                            new Error(
                                'Empty framebuffer'
                            )
                        );

                        return;

                    }

                    if (!frame.complete) {

                        handleFrameError(
                            msg,
                            new Error(
                                'Framebuffer is incomplete'
                            )
                        );

                        return;

                    }

                    node.status({
                        fill: 'blue',
                        shape: 'dot',
                        text:
                            'encoding ' +
                            frame.width +
                            'x' +
                            frame.height
                    });

                    encodeFramebuffer(
                        msg,
                        frame
                    );

                }
            );

        }

        // ============================================================
        // Encode framebuffer → PNG
        // ============================================================

        function encodeFramebuffer(
            msg,
            frame
        ) {

            try {

                var image =
                    new Jimp({
                        data: frame.data,
                        width: frame.width,
                        height: frame.height
                    });

                image.getBuffer(
                    Jimp.MIME_PNG,
                    function(
                        err,
                        pngBuffer
                    ) {

                        if (err) {

                            finishError(
                                'PNG encoding error: ' +
                                err.message
                            );

                            return;

                        }

                        /*
                         * Correctly await black-screen
                         * analysis.
                         */

                        isMostlyBlack(
                            pngBuffer,
                            function(
                                blackErr,
                                isBlack,
                                ratio
                            ) {

                                if (blackErr) {

                                    finishError(
                                        'Black-screen detection error: ' +
                                        blackErr.message
                                    );

                                    return;

                                }

                                if (isBlack) {

                                    handleBlackFrame(
                                        msg,
                                        ratio
                                    );

                                    return;

                                }

                                /*
                                 * SUCCESS
                                 */

                                msg.payload =
                                    pngBuffer;

                                /*
                                 * Optional metadata.
                                 *
                                 * Existing flows using only
                                 * msg.payload are unaffected.
                                 */

                                msg.vnc =
                                    msg.vnc ||
                                    {};

                                msg.vnc.frameSequence =
                                    frame.sequence;

                                msg.vnc.frameTimestamp =
                                    frame.timestamp;

                                msg.vnc.width =
                                    frame.width;

                                msg.vnc.height =
                                    frame.height;

                                msg.vnc.coverage =
                                    frame.coveredPixels +
                                    '/' +
                                    frame.totalPixels;

                                msg.vnc.complete =
                                    frame.complete;

                                node.send(
                                    msg
                                );

                                node.status({
                                    fill: 'green',
                                    shape: 'dot',
                                    text:
                                        'frame ' +
                                        frame.sequence +
                                        ' ready'
                                });

                                scheduleDisconnect();

                                /*
                                 * Capture finished.
                                 */

                                busy = false;

                                wakeRetryCount = 0;

                                reconnectRetryCount = 0;

                            }

                        );

                    }
                );

            }
            catch (err) {

                finishError(
                    'Framebuffer/Jimp error: ' +
                    err.message
                );

            }

        }

        // ============================================================
        // Black screen detection
        // ============================================================

        function isMostlyBlack(
            pngBuffer,
            callback
        ) {

            Jimp.read(
                pngBuffer,
                function(
                    err,
                    image
                ) {

                    if (err) {

                        callback(
                            err,
                            false,
                            0
                        );

                        return;

                    }

                    var width =
                        image.bitmap.width;

                    var height =
                        image.bitmap.height;

                    var total =
                        width * height;

                    if (total <= 0) {

                        callback(
                            null,
                            true,
                            1
                        );

                        return;

                    }

                    /*
                     * Instead of only checking the first 100
                     * pixels, sample the whole image with a
                     * controlled stride.
                     *
                     * This avoids a black top-left corner
                     * causing a false positive.
                     */

                    var maxSamples = 5000;

                    var step =
                        Math.max(
                            1,
                            Math.floor(
                                total /
                                maxSamples
                            )
                        );

                    var blackCount = 0;

                    var samples = 0;

                    for (
                        var index = 0;
                        index < total;
                        index += step
                    ) {

                        var x =
                            index % width;

                        var y =
                            Math.floor(
                                index / width
                            );

                        var rgba =
                            Jimp.int32ToRGBA(
                                image.getPixelColor(
                                    x,
                                    y
                                )
                            );

                        if (
                            rgba.r <=
                                BLACK_PIXEL_THRESHOLD &&
                            rgba.g <=
                                BLACK_PIXEL_THRESHOLD &&
                            rgba.b <=
                                BLACK_PIXEL_THRESHOLD
                        ) {

                            blackCount++;

                        }

                        samples++;

                    }

                    var ratio =
                        samples > 0
                            ? blackCount /
                              samples
                            : 1;

                    callback(
                        null,
                        ratio >=
                            BLACK_THRESHOLD,
                        ratio
                    );

                }
            );

        }

        // ============================================================
        // Handle black frame
        // ============================================================

        function handleBlackFrame(
            msg,
            ratio
        ) {

            node.warn(
                'Mostly black framebuffer detected: ' +
                Math.round(
                    ratio * 100
                ) +
                '%'
            );

            if (
                wakeRetryCount <
                MAX_WAKE_RETRIES
            ) {

                wakeRetryCount++;

                node.status({
                    fill: 'yellow',
                    shape: 'ring',
                    text:
                        'wake retry ' +
                        wakeRetryCount +
                        '/' +
                        MAX_WAKE_RETRIES
                });

                wakeScreen(
                    function(err) {

                        if (err) {

                            handleFrameError(
                                msg,
                                err
                            );

                            return;

                        }

                        setTimeout(
                            function() {

                                captureFreshFramebuffer(
                                    msg
                                );

                            },
                            WAKE_DELAY
                        );

                    }
                );

                return;

            }

            /*
             * Wake retries exhausted.
             *
             * Reconnect completely.
             */

            if (
                reconnectRetryCount <
                MAX_RECONNECT_RETRIES
            ) {

                reconnectRetryCount++;

                node.warn(
                    'Wake retries exhausted. ' +
                    'Forcing VNC reconnect ' +
                    reconnectRetryCount +
                    '/' +
                    MAX_RECONNECT_RETRIES
                );

                forceReconnect(
                    msg
                );

                return;

            }

            finishError(
                'Unable to obtain a non-black framebuffer after wake/reconnect retries'
            );

        }

        // ============================================================
        // Frame error
        // ============================================================

        function handleFrameError(
            msg,
            err
        ) {

            node.warn(
                'Framebuffer capture failed: ' +
                err.message
            );

            if (
                reconnectRetryCount <
                MAX_RECONNECT_RETRIES
            ) {

                reconnectRetryCount++;

                forceReconnect(
                    msg
                );

                return;

            }

            finishError(
                'Framebuffer capture failed: ' +
                err.message
            );

        }

        // ============================================================
        // Connection error
        // ============================================================

        function handleConnectionError(
            msg,
            err
        ) {

            if (
                reconnectRetryCount <
                MAX_RECONNECT_RETRIES
            ) {

                reconnectRetryCount++;

                node.warn(
                    'VNC connection problem: ' +
                    err.message +
                    ' - reconnecting'
                );

                forceReconnect(
                    msg
                );

                return;

            }

            finishError(
                'VNC connection error: ' +
                err.message
            );

        }

        // ============================================================
        // Force reconnect
        // ============================================================

        function forceReconnect(
            msg
        ) {

            node.status({
                fill: 'yellow',
                shape: 'ring',
                text: 'reconnecting'
            });

            try {

                if (
                    node.client &&
                    typeof node.client.disconnect ===
                        'function'
                ) {

                    node.client.disconnect();

                }

            }
            catch (err) {

                node.warn(
                    'Disconnect error: ' +
                    err.message
                );

            }

            setTimeout(
                function() {

                    if (!node.client) {

                        finishError(
                            'VNC client unavailable'
                        );

                        return;

                    }

                    node.client.perform(
                        function(err) {

                            if (err) {

                                finishError(
                                    'Reconnect failed: ' +
                                    err.message
                                );

                                return;

                            }

                            /*
                             * Reset wake retry counter
                             * after successful reconnect.
                             */

                            wakeRetryCount = 0;

                            /*
                             * Wake again.
                             */

                            wakeScreen(
                                function(wakeErr) {

                                    if (wakeErr) {

                                        finishError(
                                            'Wake after reconnect failed: ' +
                                            wakeErr.message
                                        );

                                        return;

                                    }

                                    setTimeout(
                                        function() {

                                            captureFreshFramebuffer(
                                                msg
                                            );

                                        },
                                        WAKE_DELAY
                                    );

                                }
                            );

                        }
                    );

                },
                1000
            );

        }

        // ============================================================
        // Disconnect timer
        // ============================================================

        function scheduleDisconnect() {

            if (
                disconnectTimer !== null
            ) {

                clearTimeout(
                    disconnectTimer
                );

                disconnectTimer =
                    null;

            }

            disconnectTimer =
                setTimeout(
                    function() {

                        if (
                            busy
                        ) {
                            return;
                        }

                        if (
                            node.client &&
                            typeof node.client.disconnect ===
                                'function'
                        ) {

                            node.client.disconnect();

                            node.status({
                                fill: 'grey',
                                shape: 'ring',
                                text: 'idle/disconnected'
                            });

                        }

                    },
                    3 * 60 * 1000
                );

        }

        // ============================================================
        // Finish error
        // ============================================================

        function finishError(
            message
        ) {

            busy = false;

            wakeRetryCount = 0;

            reconnectRetryCount = 0;

            node.error(
                message
            );

            node.status({
                fill: 'red',
                shape: 'ring',
                text: 'error'
            });

        }

        // ============================================================
        // Close
        // ============================================================

        node.on(
            'close',
            function() {

                busy = false;

                if (
                    disconnectTimer !== null
                ) {

                    clearTimeout(
                        disconnectTimer
                    );

                    disconnectTimer =
                        null;

                }

                if (
                    node.client &&
                    node.client.nodes
                ) {

                    var index =
                        node.client.nodes.indexOf(
                            node
                        );

                    if (index >= 0) {

                        node.client.nodes.splice(
                            index,
                            1
                        );

                    }

                }

            }
        );

    }

    // ================================================================
    // Register Node-RED node
    // ================================================================

    RED.nodes.registerType(
        'screenshot',
        screenshotNode
    );

};
