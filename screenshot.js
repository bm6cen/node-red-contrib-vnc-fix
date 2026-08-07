var Jimp = require('jimp');

module.exports = function(RED) {
  function screenshotNode(config) {
      RED.nodes.createNode(this,config);
      var node = this;
      this.client = RED.nodes.getNode(config.client);
      if (this.client) {
          this.client.nodes.push(this);
      }

      node.on('input', function(msg) {
          if (!this.client) {
              node.error('Missing VNC client configuration');
              return;
          }
          this.client.perform((err) => {
              if (err) {
                  node.status(this.client.statuses.error);
                  return;
              }
              var r = this.client.rfb;
              if (!r) {
                  node.error('No RFB instance');
                  return;
              }
              // Listen for a single rect update
              r.once('rect', (rect) => {
                  try {
                      var png = new Jimp({data: parseRectAsRGBABuffer(rect), height: rect.height, width: rect.width});
                      png.getBuffer(Jimp.MIME_PNG, (err,buf) => {
                          if (err){
                              node.error('Jimp buffer error: ' + err);
                              msg.payload = "Error: " + err;
                          } else {
                              msg.payload = buf;
                          }
                          node.send(msg);
                      });
                  } catch (e) {
                      node.error('Jimp error: ' + e);
                      msg.payload = "Error: " + e;
                      node.send(msg);
                  }
              });
              // Request update of the whole screen
              r.requestUpdate(false, 0, 0, r.width, r.height);
          });
      });

      node.on('close', () => {
          if (this.client) {
              var idx = this.client.nodes.indexOf(this);
              if (idx >= 0) this.client.nodes.splice(idx,1);
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
