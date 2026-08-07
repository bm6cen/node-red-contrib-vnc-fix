var rfb = require('rfb2');

module.exports = function(RED) {
    function vncClientNode(n) {
        RED.nodes.createNode(this,n);
        //Config Params
        this.host = n.host;
        this.port = n.port;
        this.password = n.password;

        //Instance Vars
        this.connected = false;
        this.connecting = false;
        this.nodes = [];
        this.statuses = {
            connected: {fill: 'green', shape: 'dot', text: 'connected'},
            connecting: {fill: 'yellow', shape: 'ring', text: 'connecting'},
            error: {fill: 'red', shape: 'ring', text: 'error'}
        };

        //Node Events
        this.on('close', (removed,deleted) => {
            if (this.rfb) {
                this.rfb.end();
                this.rfb = null;
            }
            // done callback is not needed; Node-RED handles it
        });

        //Functions
        this.connect = (callback) => {
            callback = callback || function(){};
            if (this.rfb) {
                // already have an instance, try to reuse if connected
                if (this.connected) {
                    return callback();
                }
                // otherwise end old and create new
                this.rfb.end();
                this.rfb = null;
            }
            this.connecting = true;
            this.updateStatus(this.statuses.connecting);
            this.rfb = rfb.createConnection({
                host: this.host,
                port: this.port,
                password: this.password
            });
            this.rfb.on('connect', () => {
                this.connected = true;
                this.connecting = false;
                this.updateStatus(this.statuses.connected);
                this.clipboardNodes('register');
                callback();
            }).on('error', (err) => {
                this.connecting = false;
                // Handle specific socket end error
                if (err && err.message && err.message.includes('This socket has been ended by the other party')) {
                    this.connected = false;
                    this.clipboardNodes('unregister');
                    // Try to reconnect automatically
                    this.connect(callback);
                    return;
                }
                this.updateStatus(this.statuses.error);
                this.clipboardNodes('unregister');
                this.error(err);
                return callback(err);
            }).on('close', () => {
                // Server closed connection
                this.connected = false;
                this.connecting = false;
                this.clipboardNodes('unregister');
                this.updateStatus(this.statuses.error);
                this.error('Connection closed by remote');
                // Optionally attempt reconnect on next perform
            });
        };

        this.updateStatus = (status) => {
            this.nodes.forEach((node) => {node.status(status)});
        };

        this.clipboardNodes = (func) => {
            switch(func){
                case 'register':
                    this.nodes.forEach((n) => {
                        if (n.type == 'clipboard' && !n.registered) n.register();
                    });
                    break;
                case 'unregister':
                    this.nodes.forEach((n) => {
                        if (n.type == 'clipboard') n.registered = false;
                    });
                    break;
            }
        };

        this.perform = (callback) => {
            callback = callback || function(){};
            if (this.connected && this.rfb) {
                callback();
            } else if (this.connecting) {
                this.error('Error: Connection attempt already in progress');
                return callback('Error: Connection attempt already in progress');
            } else {
                this.connect(callback);
            }
        };
    }
    RED.nodes.registerType('vnc-client',vncClientNode);
};

