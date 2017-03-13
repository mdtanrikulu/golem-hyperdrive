const fs = require('fs');
const mkdirp = require('mkdirp');
const level = require('level');
const path = require('path');
const uuid = require('uuid/v4');

const hyperdrive = require('hyperdrive');
const importer = require('hyperdrive-import-files');
const discovery = require('discovery-swarm');
const defaults = require('datland-swarm-defaults');

const Archiver = require('./archiver');
const RPC = require('./rpc');

process.setMaxListeners(0);

process.on('SIGPIPE', arg => {
    console.error("HyperG warning: broken pipe");
});

function HyperG(options) {
    if (!(this instanceof HyperG))
        return new HyperG(options);

    this.options = options;
    this.options.db = options.db || './hyperg.db';
    this.id = uuid();

    this.tx_networks = [];
    this.rx_networks = [];
    this._running = false;
}

HyperG.prototype.run = function() {
    if (this._running) return;
    this._running = true;

    this.expose_rpc()
        .then(() => {
            console.info("HyperG is ready");
        }, this.exit);
}

HyperG.prototype.upload = function(id, files, hash) {
    var self = this;
    var drive = self._create_hyperdrive();
    var archive = drive.createArchive(hash);

    return new Promise((cb, eb) => {

        const on_finalize = error => {
            if (error) return eb(error);

            var hash = archive.key.toString('hex');
            var network = self._create_network(archive, false);

            network.once('listening', () => {
                console.info("HyperG: share ", hash);
                network.join(archive.discoveryKey);
                self.tx_networks[hash] = network;
                cb(hash);
            });

            network.on('error', eb);
            network.listen(0);
        };

        if (hash)
            importer(archive, dst, null, on_finalize);
        else
            Archiver.add(archive, files, (file, error, left) => {
                if (error) return eb(error);
                if (left <= 0) archive.finalize(on_finalize);
            });
    });
}

HyperG.prototype.download = function(hash, destination) {
    var self = this, key = uuid();
    var drive = self._create_hyperdrive();
    var archive = drive.createArchive(hash);
    var network = self._create_network(archive, true);

    return new Promise((cb, eb) => {

        const on_open = error => {
            if (error) return eb(error);

            console.info("HyperG: get   ", hash);

            Archiver.get(archive, destination, (error, files) => {
                if (error) return eb(error);
                console.info("HyperG: done  ", hash);
                cb(files);
            });
        }

        network.once('listening', () => {
            network.join(archive.discoveryKey);
            self.rx_networks[key] = network;
            archive.open(on_open);
        });

        network.on('error', eb);
        network.listen(0);
    });
}

HyperG.prototype.cancel_upload = function(hash, cb) {
    var self = this;
    const exists = hash in self.tx_networks;

    if (exists)
        self._close_network(self.tx_networks[hash], () => {
            if (hash in self.tx_networks)
                delete self.tx_networks[hash];
            cb();
        });

    return exists;
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

    process.exit(code);
}

HyperG.prototype._create_hyperdrive = function(hash) {
    const db = this.options.db;
    var dst = this._path(hash);

    if (fs.existsSync(dst))
        dst = this._path();
    mkdirp.sync(dst);

    return hyperdrive(level(dst));
}

HyperG.prototype._create_network = function(archive, download) {
    options = Object.assign({
        id: archive.id,
        hash: false,
        stream: peer => {
            return archive.replicate({
                upload: true,
                download: !!download
            });
        },
    }, this.options);

    var network = discovery(defaults(options));
    network.archive = archive;
    network.db = archive.drive.core._db;
    this._log_errors(network);
    return network;
}

HyperG.prototype._close_network = function(network, cb) {
    network.archive.unreplicate();
    network.leave(network.archive.discoveryKey);
    network.once('close', () => {
        network.archive.close(() => {
            network.db.close(cb);
        });
    });
    network.destroy();
}

HyperG.prototype._path = function(hash) {
    return path.join(this.options.db, hash || uuid());
}

HyperG.prototype._log_errors = function(emitter) {
    emitter.on('error', error => {
        console.error('HyperG error:', error);
    });
}

module.exports = HyperG;
