var Jimp = require('jimp');

module.exports = function(RED) {
  function screenshotNode(config) {
      RED.nodes.createNode(this,config);
      var node = this;
      this.client = RED.nodes.getNode(config.client);
      if (this.client) {
          this.client.nodes.push(this);
      }
      var disconnectTimer = null;

      node.on('input', function(msg) {
          if (!this.client) {
              node.error('Missing VNC client configuration');
              return;
          }
          // Ensure client is connected
          if (this.client.connect && typeof this.client.connect === 'function') {
              this.client.connect();
          }
          // Wake VNC server with two mouse clicks
          this.client.perform((err) => {
              if (err) {
                  node.error('Failed to perform wake clicks: ' + err);
                  // Continue anyway?
              } else {
                  var r = this.client.rfb;
                  if (r) {
                      // First click at (1,1)
                      r.pointerEvent(1, 1, 1); // down
                      setTimeout(() => {
                          r.pointerEvent(1, 1, 0); // up
                          // Second click at (1,2) after a short delay
                          setTimeout(() => {
                              r.pointerEvent(1, 2, 1); // down
                              setTimeout(() => {
                                  r.pointerEvent(1, 2, 0); // up
                              }, 50);
                          }, 50);
                      }, 50);
                  }
              }
              // Now proceed with screenshot
              this.client.perform((err2) => {
                  if (err2) {
                      node.status(this.client.statuses.error);
                      return;
                  }
                  var r = this.client.rfb;
                  if (!r) {
                      node.error('No RFB instance');
                      return;
                  }
                  // Listen for a single rect update
                  function onRect(rect) {
                      try {
                          var png = new Jimp({data: parseRectAsRGBABuffer(rect), height: rect.height, width: rect.width});
                          png.getBuffer(Jimp.MIME_PNG, (err,buf) => {
                              if (err){
                                  node.error('Jimp buffer error: ' + err);
                                  msg.payload = 'Error: ' + err;
                              } else {
                                  msg.payload = buf;
                              }
                              node.send(msg);
                              // Start disconnect timer after sending screenshot
                              if (disconnectTimer !== null) {
                                  clearTimeout(disconnectTimer);
                              }
                              disconnectTimer = setTimeout(function() {
                                  if (node.client && typeof node.client.disconnect === 'function') {
                                      node.client.disconnect();
                                      node.status({fill:"green",shape:"dot",text:"disconnected"});
                                  }
                              }, 3 * 60 * 1000); // 3 minutes
                          });
                      } catch (e) {
                          node.error('Jimp error: ' + e);
                          msg.payload = 'Error: ' + e;
                          node.send(msg);
                      }
                      // Important: remove listener after receiving rect
                      r.removeListener('rect', onRect);
                  }
                  r.once('rect', onRect);
                  // Force a full screen update to wake up old VNC servers
                  r.requestUpdate(true, 0, 0, r.width, r.height);
              });
          });
      });

      node.on('close', () => {
          if (this.client) {
              var idx = this.client.nodes.indexOf(this);
              if (idx >= 0) this.client.nodes.splice(idx,1);
          }
          if (disconnectTimer !== null) {
              clearTimeout(disconnectTimer);
          }
      });
  }
  RED.nodes.registerType("screenshot",screenshotNode);
};

allocBinaryBuffer = (size) => {
  return Buffer.alloc(size);
};

parseRectAsRGBABuffer = (rect) => {
  const size = rect.width * rect.height * 4;
  const rgba = allocBinaryBuffer(size);
  for (let i = 0; i < size; i += 4) {
    rgba.writeUInt8(rect.data[i + 2], i);     // R
    rgba.writeUInt8(rect.data[i + 1], i + 1); // G
    rgba.writeUInt8(rect.data[i], i + 2);     // B
    rgba.writeUInt8(255, i + 3);              // A
  }
  return rgba;
};
