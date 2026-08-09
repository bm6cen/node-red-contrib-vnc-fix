var Jimp = require('jimp');

module.exports = function(RED) {
    function screenshotNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        this.client = RED.nodes.getNode(config.client);
        if (this.client) {
            if (!this.client.nodes) {
                this.client.nodes = [];
            }
            this.client.nodes.push(this);
        }
        var disconnectTimer = null;
        var busy = false;
        var wakeRetryCount = 0;
        var sameRetryCount = 0;
        const MAX_WAKE_RETRIES = 3;
        const WAKE_DELAY = 1500; // 1.5秒
        const CAPTURE_TIMEOUT = 2500; // 2.5秒
        const BLACK_THRESHOLD = 0.9; // 90%
        const MAX_SAME_RETRIES = 3;
        // store last frame per client
        var lastFrames = {};

        node.on('input', function(msg) {
            if (busy) {
                node.warn('Screenshot already in progress - request ignored');
                return;
            }
            if (!this.client) {
                node.error('Missing VNC client configuration');
                return;
            }
            busy = true;
            wakeRetryCount = 0;
            sameRetryCount = 0;
            node.status({fill:'yellow',shape:'dot',text:'capturing...'});
            captureAndSend(msg);
        });

        function captureAndSend(msg) {
            this.client.perform(function(err) {
                if (err) {
                    finishError('VNC perform error: ' + err);
                    return;
                }
                // Wait for fresh frame
                this.client.getFreshFrame(CAPTURE_TIMEOUT, function(err2, frameInfo) {
                    if (err2) {
                        finishError('Failed to get fresh frame: ' + err2);
                        return;
                    }
                    // Now capture
                    this.client.perform(function(err3) {
                        if (err3) {
                            finishError('Second perform error: ' + err3);
                            return;
                        }
                        var r = this.client.rfb;
                        if (!r) {
                            finishError('No RFB instance');
                            return;
                        }
                        function onRect(rect) {
                            try {
                                var png = new Jimp({data: parseRectAsRGBABuffer(rect), height: rect.height, width: rect.width});
                                png.getBuffer(Jimp.MIME_PNG, function(err4, buf) {
                                    if (err4) {
                                        finishError('Jimp buffer error: ' + err4);
                                        return;
                                    }
                                    // Check if image is mostly black
                                    if (isMostlyBlack(buf)) {
                                        // If not yet retried, wake again and retry
                                        if (wakeRetryCount < MAX_WAKE_RETRIES) {
                                            wakeRetryCount++;
                                            node.warn('Detected mostly black image, waking VNC again...');
                                            // Wake VNC with pointer moves and double click at (0,0)
                                            this.client.perform(function(wakeErr) {
                                                if (wakeErr) {
                                                    node.error('Wake failed: ' + wakeErr);
                                                }
                                                // perform wake sequence
                                                var rfb = this.client.rfb;
                                                if (rfb) {
                                                    // move to (0,0)
                                                    rfb.pointerEvent(0, 0, 0);
                                                    setTimeout(function() {
                                                        // move to (1,1)
                                                        rfb.pointerEvent(1, 1, 0);
                                                        setTimeout(function() {
                                                            // first click at (0,0)
                                                            rfb.pointerEvent(0, 0, 1); // down
                                                            setTimeout(function() {
                                                                rfb.pointerEvent(0, 0, 0); // up
                                                                setTimeout(function() {
                                                                    // second click at (0,0)
                                                                    rfb.pointerEvent(0, 0, 1); // down
                                                                    setTimeout(function() {
                                                                        rfb.pointerEvent(0, 0, 0); // up
                                                                        // after wake, wait a bit then retry capture
                                                                        setTimeout(function() {
                                                                            captureAndSend(msg);
                                                                        }.bind(this), WAKE_DELAY);
                                                                    }.bind(this), 50);
                                                                }.bind(this), 50);
                                                            }.bind(this), 50);
                                                        }.bind(this), 50);
                                                    }.bind(this), 50);
                                                } else {
                                                    // fallback: just wait then retry
                                                    setTimeout(function() {
                                                        captureAndSend(msg);
                                                    }.bind(this), WAKE_DELAY);
                                                }
                                            }.bind(this));
                                            return;
                                        } else {
                                            // Exceeded wake retries, force reconnect
                                            node.warn('Exceeded wake retries, forcing VNC reconnect...');
                                            forceReconnectAndRetry(msg);
                                            return;
                                        }
                                    }
                                    // Check if same as last frame for this client
                                    var clientId = this.client.id || this.client.host + ':' + this.client.port;
                                    var last = lastFrames[clientId];
                                    if (last && buf.equals(last)) {
                                        // same frame
                                        if (sameRetryCount < MAX_SAME_RETRIES) {
                                            sameRetryCount++;
                                            node.warn('Same frame as last (' + sameRetryCount + '/' + MAX_SAME_RETRIES + '), retrying...');
                                            // small delay then retry capture
                                            setTimeout(function() {
                                                captureAndSend(msg);
                                            }.bind(this), 500);
                                            return;
                                        } else {
                                            node.warn('Same frame after ' + MAX_SAME_RETRIES + ' retries, forcing VNC reconnect...');
                                            forceReconnectAndRetry(msg);
                                            return;
                                        }
                                    }
                                    // Good image
                                    msg.payload = buf;
                                    node.send(msg);
                                    // Store as last frame
                                    lastFrames[clientId] = buf;
                                    // Reset same counter
                                    sameRetryCount = 0;
                                    // Start disconnect timer
                                    if (disconnectTimer !== null) {
                                        clearTimeout(disconnectTimer);
                                    }
                                    disconnectTimer = setTimeout(function() {
                                        if (node.client && typeof node.client.disconnect === 'function') {
                                            node.client.disconnect();
                                            node.status({fill:'green',shape:'dot',text:'disconnected'});
                                        }
                                    }, 3 * 60 * 1000);
                                });
                            } catch (e) {
                                finishError('Jimp error: ' + e);
                            }
                            r.removeListener('rect', onRect);
                        }
                        r.once('rect', onRect);
                        // Request full update
                        r.requestUpdate(true, 0, 0, r.width, r.height);
                    }.bind(this));
                }.bind(this));
            }.bind(this));
        }

        function forceReconnectAndRetry(msg) {
            // Disconnect if possible
            if (this.client && typeof this.client.disconnect === 'function') {
                try {
                    this.client.disconnect();
                } catch (e) {
                    node.error('Disconnect error: ' + e);
                }
            }
            // Reset state
            busy = false;
            wakeRetryCount = 0;
            sameRetryCount = 0;
            // Wait a bit then retry capture (will reconnect via perform)
            setTimeout(function() {
                node.status({fill:'yellow',shape:'dot',text:'reconnecting...'});
                captureAndSend(msg);
            }.bind(this), 1000);
        }

        function finishError(errMsg) {
            busy = false;
            node.error(errMsg);
            node.status({fill:'red',shape:'ring',text:'error'});
        }

        function isMostlyBlack(pngBuf) {
            // Quick heuristic: check first few pixels; if all near zero, likely black
            // We'll decode with Jimp again for simplicity (could be optimized)
            Jimp.read(pngBuf, function(err, image) {
                if (err) return true; // treat as black on error
                var blackCount = 0;
                var total = image.bitmap.width * image.bitmap.height;
                var limit = Math.min(total, 100); // sample up to 100 pixels
                var idx = 0;
                for (var y = 0; y < image.bitmap.height && idx < limit; y++) {
                    for (var x = 0; x < image.bitmap.width && idx < limit; x++) {
                        var rgba = image.getPixelColor(x, y);
                        var r = Jimp.int32ToRGBA(rgba).r;
                        var g = Jimp.int32ToRGBA(rgba).g;
                        var b = Jimp.int32ToRGBA(rgba).b;
                        if (r < 10 && g < 10 && b < 10) blackCount++;
                        idx++;
                    }
                }
                // If more than threshold sampled pixels are black, treat as black
                node.warn('Black pixel ratio: ' + (blackCount / limit));
                return (blackCount / limit) > BLACK_THRESHOLD;
            });
            // Synchronous fallback: assume not black if we can't wait
            return false;
        }

        node.on('close', function() {
            if (this.client) {
                var idx = this.client.nodes.indexOf(this);
                if (idx >= 0) this.client.nodes.splice(idx,1);
            }
            if (disconnectTimer !== null) {
                clearTimeout(disconnectTimer);
            }
        });
    }

    function allocBinaryBuffer(size) {
        return Buffer.alloc(size);
    }

    function parseRectAsRGBABuffer(rect) {
        const size = rect.width * rect.height * 4;
        const rgba = allocBinaryBuffer(size);
        for (let i = 0; i < size; i += 4) {
            rgba.writeUInt8(rect.data[i + 2], i);     // R
            rgba.writeUInt8(rect.data[i + 1], i + 1); // G
            rgba.writeUInt8(rect.data[i], i + 2);     // B
            rgba.writeUInt8(255, i + 3);              // A
        }
        return rgba;
    }

    RED.nodes.registerType("screenshot", screenshotNode);
};
