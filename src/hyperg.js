const fs = require('fs');
const mkdirp = require('mkdirp');
const level = require('level');
const uuid = require('uuid/v4');

const hyperdrive = require('hyperdrive');
const discovery = require('discovery-swarm');
const defaults = require('datland-swarm-defaults');

const Archiver = require('./archiver');
const RPC = require('./rpc');

process.setMaxListeners(0);


function HyperG(options) {
    if (!(this instanceof HyperG))
        return new HyperG(options);

    this.options = options;
    this.db = level(options.db || './hyperg.db');
    this.hyperdrive = hyperdrive(this.db);
    this.id = uuid();

    this.tx_networks = [];
    this.rx_networks = [];
    this._running = false;
}

HyperG.prototype.run = function() {
    var self = this;

    if (self._running) return;
    self._running = true;

    self.expose_rpc()
        .then(() => {
            console.info("HyperG is ready");
        }, error => {
            self.exit(error);
        });
}

HyperG.prototype.upload = function(id, files) {
    var self = this;
    var archive = self.hyperdrive.createArchive();

    return new Promise((cb, err) => {
        Archiver.add(archive, files, (file, error, left) => {
            if (error) return err(error);
            if (left <= 0) {
                archive.finalize();

                var hash = archive.key.toString('hex');
                var network = self._create_network(archive, false);
                self.tx_networks[hash] = network;

                network.listen(0);
                network.join(archive.discoveryKey);

                console.info("HyperG: upload  ", hash);
                cb(hash);
            }
        });
    });
}

HyperG.prototype.download = function(hash, destination) {
    var self = this, files = [];
    var archive = self.hyperdrive.createArchive(hash);
    var network = self._create_network(archive);

    network.listen(0);
    network.join(archive.discoveryKey);
    self.rx_networks[uuid()] = network;

    console.info("HyperG: download", hash);

    return new Promise((cb, eb) => {
        archive.open(error => {
            if (error) return eb(error);

            Archiver.get(archive, destination, (file, error, left) => {
                if (error) return eb(error);
                files.push(file);
                if (left <= 0) cb(files);
            });
        });
    });
}

HyperG.prototype.cancel_upload = function(hash) {
    var self = this;
    const exists = hash in this.tx_networks;

    if (exists) {
        console.info("HyperG: cancelling", hash);
        this.tx_networks[hash].leave(key);

        setTimeout(() => {
            if (hash in this.tx_networks)
                delete self.tx_networks[hash];
        }, 5);
    }

    return exists;
}

HyperG.prototype.cancel_download = function(key) {
    var self = this;

    if (key in this.rx_networks) {
        this.rx_networks[key].leave(key);

        setTimeout(() => {
            if (key in this.rx_networks)
                delete self.rx_networks[key];
        }, 5);
    }
}

HyperG.prototype.expose_rpc = function(port, host) {
    host = host || 'localhost';
    this.rpc = new RPC(this, port, host);
    return this.rpc.listen();
}

HyperG.prototype.exit = function(message, code) {
    if (message)
        console.error(message);

    const _try = fn => {
        try { fn(); }
        catch (e) { console.error('HyperG error:', e); }
    }

    for (var key in self.rx_networks)
        if (self.rx_networks.hasOwnProperty(key))
            _try(self.rx_networks[key].close);

    for (var key in self.tx_networks)
        if (self.tx_networks.hasOwnProperty(key))
            _try(self.tx_networks[key].close);

    _try(self.db.close);
    process.exit(code);
}

HyperG.prototype._create_network = function(archive, download) {
    options = Object.assign({
        id: archive.id,
        hash: false,
        stream: peer => {
            return archive.replicate({
                upload: true,
                download: download !== false
            });
        },
    }, this.options);

    var network = discovery(defaults(options));
    this._log_errors(network);
    return network;
}

HyperG.prototype._log_errors = function(emitter) {
    emitter.on('error', error => {
        console.error('HyperG error:', error);
    });
}

module.exports = HyperG;
