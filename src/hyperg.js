const fs = require('fs');
const mkdirp = require('mkdirp');
const level = require('level');

const hyperdrive = require('hyperdrive');
const discovery = require('discovery-swarm');
const defaults = require('datland-swarm-defaults');

const Archiver = require('./archiver');
const RPC = require('./rpc');

process.setMaxListeners(0);


const DEFAULT_HOST = 'localhost';
const DEFAULT_PORT = 3282;


function HyperG(options) {
    if (!(this instanceof HyperG))
        return new HyperG(options);

    this.options = options;
    this.db = level(options.db || './hyperg.db');
    this.hyperdrive = hyperdrive(this.db);

    this.options.port = this.options.port || DEFAULT_PORT;
    this.tx_network = this._create_network();
    this.rx_networks = [];

    this._uploads = {};
    this._running = false;
}

HyperG.prototype.run = function() {
    var self = this;

    if (self._running) return;
    self._running = true;

    self.tx_network.on('connection', (connection, info) => {
        self._log_errors(connection);
        self._read(connection, 32, hash => {

            hash = hash.toString('hex');
            if (!(hash in self._uploads)) {
                console.error("HyperG: Invalid hash", hash.toString(),
                              connection._peername);
                return connection.destroy();
            }

            console.info("HyperG: upload  ", hash.toString(),
                         connection._peername);

            var archive = self._uploads[hash];
            connection.pipe(archive.replicate({
                download: false,
                upload: true
            }))
            .on('error', err => {
                console.error("HyperG: Archive replication error:", err);
                connection.destroy();
            })
            .pipe(connection)
            .on('error', err => {
                console.error("HyperG: Connection replication error:", err);
                connection.destroy();
            });
        });
    });

    self.tx_network.on('error', error => {
        self.exit(error);
    });

    self.tx_network.on('listening', () => {
        self.expose_rpc()
            .then(() => {
                console.info("HyperG is ready");
            }, error => {
                self.exit(error);
            });
    });

    self.tx_network.listen(self.options.tx_port);
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
                if (hash in self._uploads)
                    self.cancel_upload(hash);

                console.info("HyperG: share   ", hash);

                self._uploads[hash] = archive;
                self.tx_network.join(archive.discoveryKey, null, hash);
                cb(hash);
            }
        });
    });
}

HyperG.prototype.download = function(hash, destination) {
    var self = this;
    var network = self._create_network();

    network.listen(0);
    self.rx_networks[hash + destination] = network;

    console.info("HyperG: download", hash);

    return new Promise((cb, eb) => {
        var archive = self.hyperdrive.createArchive(hash);

        network.once('connection', (connection, info) => {
            self._on_download_connection(connection, info, archive,
                                         destination, cb, eb);
        });

        network.join(archive.discoveryKey, null, hash);
    });
}

HyperG.prototype._on_download_connection = function(connection, info, archive,
                                                    destination, callback, errback) {
    var files = [];

    this._log_errors(connection);
    connection.write(archive.key, null, () => {

        connection.pipe(archive.replicate({
            download: true,
            upload: false
        }))
        .on('error', err => {
            console.error("HyperG: Archive replication error:", err);
            connection.destroy();
        })
        .pipe(connection)
        .on('error', err => {
            console.error("HyperG: Connection replication error:", err);
            connection.destroy();
        });

        Archiver.get(archive, destination, (file, error, left) => {
            if (error) {
                errback(error);
                connection.destroy();
            } else
                files.push(file);

            if (left <= 0) callback(files);
        });
    });
}

HyperG.prototype._read = function(connection, count, callback) {
    var self = this;
    var read = connection.read(count);

    if (read === null)
        connection.once('readable', function() {
            self._read(connection, count, callback);
        });
    else
        callback(read);
}

HyperG.prototype._log_errors = function(emitter) {
    emitter.on('error', error => {
        console.error('HyperG error:', error);
    });
}

HyperG.prototype.cancel_upload = function(hash) {
    const exists = hash in self._uploads;
    if (exists) {
        console.info("HyperG: cancelling", hash);
        self.tx_network.leave(hash);
        delete self._uploads[hash];
    }
    return exists;
}

HyperG.prototype.expose_rpc = function(port, host) {
    host = host || DEFAULT_HOST;
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

    _try(self.tx_network.close)
    _try(self.db.close);
    process.exit(code);
}

HyperG.prototype._create_network = function(options) {
    options = Object.assign({}, this.options, options || {});
    var network = discovery(defaults(options));

    network.on('error', error => {
        console.error("HyperG error:", error);
    });
    return network;
}

module.exports = HyperG;
