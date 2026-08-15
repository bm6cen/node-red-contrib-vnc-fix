var Jimp = require("jimp");

module.exports = function(RED) {

    function ScreenshotNode(config) {

        RED.nodes.createNode(
            this,
            config
        );

        var node = this;

        this.client =
            RED.nodes.getNode(
                config.client
            );

        if (!this.client) {

            node.error(
                "VNC client not configured"
            );

            return;

        }

        if (
            !this.client.nodes
        ) {

            this.client.nodes = [];

        }

        this.client.nodes.push(
            this
        );

        /*
         * ----------------------------------------------------------
         * SETTINGS
         * ----------------------------------------------------------
         */

        var WAKE_DELAY = 1500;

        var FRAME_TIMEOUT = 6000;

        var BLACK_THRESHOLD = 0.90;

        var BLACK_PIXEL = 15;

        var MAX_WAKE_RETRY = 2;

        var busy = false;

        var wakeRetry = 0;

        var disconnectTimer = null;

        /*
         * ----------------------------------------------------------
         * INPUT
         * ----------------------------------------------------------
         */

        node.on(
            "input",
            function(msg) {

                if (busy) {

                    node.warn(
                        "Screenshot already running"
                    );

                    return;

                }

                busy = true;

                wakeRetry = 0;

                node.setStatus =
                    function(
                        fill,
                        shape,
                        text
                    ) {

                        try {

                            node.status({
                                fill: fill,
                                shape: shape,
                                text: text
                            });

                        }
                        catch (e) {}

                    };

                node.setStatus(
                    "yellow",
                    "dot",
                    "start"
                );

                capture(
                    msg
                );

            }
        );

        /*
         * ----------------------------------------------------------
         * CAPTURE
         * ----------------------------------------------------------
         */

        function capture(msg) {

            if (!node.client) {

                fail(
                    "VNC client unavailable"
                );

                return;

            }

            node.setStatus(
                "yellow",
                "ring",
                "connect"
            );

            node.client.perform(
                function(err) {

                    if (err) {

                        fail(
                            "VNC connect failed: " +
                            err.message
                        );

                        return;

                    }

                    /*
                     * Wake MT8071iE.
                     */

                    wake(
                        function(wakeErr) {

                            if (wakeErr) {

                                fail(
                                    "Wake failed: " +
                                    wakeErr.message
                                );

                                return;

                            }

                            /*
                             * Allow HMI to repaint.
                             */

                            setTimeout(
                                function() {

                                    getFrame(
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

        /*
         * ----------------------------------------------------------
         * WAKE
         * ----------------------------------------------------------
         */

        function wake(callback) {

            if (
                !node.client ||
                !node.client.rfb
            ) {

                callback(
                    new Error(
                        "VNC unavailable"
                    )
                );

                return;

            }

            var r =
                node.client.rfb;

            try {

                /*
                 * Move cursor.
                 */

                r.pointerEvent(
                    0,
                    0,
                    0
                );

                setTimeout(
                    function() {

                        if (
                            !node.client.rfb
                        ) {

                            callback(
                                new Error(
                                    "VNC disconnected"
                                )
                            );

                            return;

                        }

                        r.pointerEvent(
                            1,
                            1,
                            0
                        );

                        setTimeout(
                            function() {

                                r.pointerEvent(
                                    0,
                                    0,
                                    1
                                );

                                setTimeout(
                                    function() {

                                        r.pointerEvent(
                                            0,
                                            0,
                                            0
                                        );

                                        setTimeout(
                                            function() {

                                                r.pointerEvent(
                                                    0,
                                                    0,
                                                    1
                                                );

                                                setTimeout(
                                                    function() {

                                                        r.pointerEvent(
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

                callback(
                    err
                );

            }

        }

        /*
         * ----------------------------------------------------------
         * GET FRAME
         * ----------------------------------------------------------
         */

        function getFrame(msg) {

            node.setStatus(
                "blue",
                "dot",
                "request framebuffer"
            );

            node.client.captureFrame(
                FRAME_TIMEOUT,
                function(
                    err,
                    frame
                ) {

                    if (err) {

                        /*
                         * Timeout is a real error.
                         *
                         * But DON'T immediately reconnect
                         * repeatedly.
                         */

                        fail(
                            "Framebuffer failed: " +
                            err.message
                        );

                        return;

                    }

                    if (
                        !frame ||
                        !frame.data
                    ) {

                        fail(
                            "Empty framebuffer"
                        );

                        return;

                    }

                    node.setStatus(
                        "blue",
                        "dot",
                        "encoding " +
                        frame.width +
                        "x" +
                        frame.height
                    );

                    encode(
                        msg,
                        frame
                    );

                }
            );

        }

        /*
         * ----------------------------------------------------------
         * ENCODE
         * ----------------------------------------------------------
         */

        function encode(
            msg,
            frame
        ) {

            try {

                var image =
                    new Jimp({
                        data:
                            frame.data,

                        width:
                            frame.width,

                        height:
                            frame.height
                    });

                image.getBuffer(
                    Jimp.MIME_PNG,
                    function(
                        err,
                        png
                    ) {

                        if (err) {

                            fail(
                                "PNG encode failed: " +
                                err.message
                            );

                            return;

                        }

                        /*
                         * IMPORTANT:
                         *
                         * Do not reconnect because the
                         * image happens to be identical
                         * to the previous screenshot.
                         */

                        detectBlack(
                            png,
                            function(
                                blackErr,
                                isBlack,
                                ratio
                            ) {

                                if (blackErr) {

                                    fail(
                                        "Black detection failed: " +
                                        blackErr.message
                                    );

                                    return;

                                }

                                /*
                                 * Black framebuffer.
                                 */

                                if (isBlack) {

                                    if (
                                        wakeRetry <
                                        MAX_WAKE_RETRY
                                    ) {

                                        wakeRetry++;

                                        node.warn(
                                            "Black framebuffer: " +
                                            Math.round(
                                                ratio *
                                                100
                                            ) +
                                            "%, wake retry " +
                                            wakeRetry
                                        );

                                        wake(
                                            function(
                                                wakeErr
                                            ) {

                                                if (
                                                    wakeErr
                                                ) {

                                                    fail(
                                                        wakeErr.message
                                                    );

                                                    return;

                                                }

                                                setTimeout(
                                                    function() {

                                                        getFrame(
                                                            msg
                                                        );

                                                    },
                                                    WAKE_DELAY
                                                );

                                            }
                                        );

                                        return;

                                    }

                                    fail(
                                        "MT8071iE framebuffer remains black after wake retries"
                                    );

                                    return;

                                }

                                /*
                                 * ------------------------------------------------
                                 * SUCCESS
                                 * ------------------------------------------------
                                 */

                                msg.payload =
                                    png;

                                msg.vnc =
                                    msg.vnc ||
                                    {};

                                msg.vnc.frameSequence =
                                    frame.sequence;

                                msg.vnc.frameTimestamp =
                                    frame.timestamp;

                                msg.vnc.rectCount =
                                    frame.rectCount;

                                msg.vnc.width =
                                    frame.width;

                                msg.vnc.height =
                                    frame.height;

                                node.send(
                                    msg
                                );

                                node.setStatus(
                                    "green",
                                    "dot",
                                    "frame " +
                                    frame.sequence
                                );

                                wakeRetry = 0;

                                busy = false;

                                /*
                                 * Keep connection alive for
                                 * 3 minutes.
                                 */

                                scheduleDisconnect();

                            }

                        );

                    }
                );

            }
            catch (err) {

                fail(
                    "Image processing failed: " +
                    err.message
                );

            }

        }

        /*
         * ----------------------------------------------------------
         * BLACK DETECTION
         * ----------------------------------------------------------
         */

        function detectBlack(
            png,
            callback
        ) {

            Jimp.read(
                png,
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
                        width *
                        height;

                    if (
                        total <= 0
                    ) {

                        callback(
                            null,
                            true,
                            1
                        );

                        return;

                    }

                    /*
                     * Sample approximately 5000 pixels.
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

                    var black = 0;

                    var samples = 0;

                    var i;

                    for (
                        i = 0;
                        i < total;
                        i += step
                    ) {

                        var x =
                            i % width;

                        var y =
                            Math.floor(
                                i / width
                            );

                        var color =
                            Jimp.int32ToRGBA(
                                image.getPixelColor(
                                    x,
                                    y
                                )
                            );

                        if (
                            color.r <=
                                BLACK_PIXEL &&
                            color.g <=
                                BLACK_PIXEL &&
                            color.b <=
                                BLACK_PIXEL
                        ) {

                            black++;

                        }

                        samples++;

                    }

                    var ratio =
                        samples > 0
                            ? black /
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

        /*
         * ----------------------------------------------------------
         * DISCONNECT TIMER
         * ----------------------------------------------------------
         */

        function scheduleDisconnect() {

            if (
                disconnectTimer
            ) {

                clearTimeout(
                    disconnectTimer
                );

            }

            disconnectTimer =
                setTimeout(
                    function() {

                        if (busy) {
                            return;
                        }

                        if (
                            node.client &&
                            typeof node.client.disconnect ===
                                "function"
                        ) {

                            node.client.disconnect();

                            node.setStatus(
                                "grey",
                                "ring",
                                "idle"
                            );

                        }

                    },
                    3 * 60 * 1000
                );

        }

        /*
         * ----------------------------------------------------------
         * ERROR
         * ----------------------------------------------------------
         */

        function fail(message) {

            busy = false;

            wakeRetry = 0;

            node.error(
                message
            );

            node.setStatus(
                "red",
                "ring",
                "error"
            );

        }

        /*
         * ----------------------------------------------------------
         * CLOSE
         * ----------------------------------------------------------
         */

        node.on(
            "close",
            function() {

                busy = false;

                if (
                    disconnectTimer
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

                    if (
                        index >= 0
                    ) {

                        node.client.nodes.splice(
                            index,
                            1
                        );

                    }

                }

            }
        );

    }

    RED.nodes.registerType(
        "screenshot",
        ScreenshotNode
    );

};
