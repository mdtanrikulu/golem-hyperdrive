const fs = require('fs');
const mkdirp = require('mkdirp');
const level = require('level');

const hyperdrive = require('hyperdrive');
const discovery = require('discovery-swarm');
const defaults = require('datland-swarm-defaults');

const Archiver = require('./archiver');
const RPC = require('./rpc');


function HyperG(options) {
    if (!(this instanceof HyperG))
        return new HyperG(options);

    this.options = options;
    this.db = level(options.db || './hyperg.db');
    this.hyperdrive = hyperdrive(this.db);

    this.options.port = this.options.port || 3282;
    this.tx_network = this._create_network();
    this.rx_networks = [];

    this._uploads = {};
    this._files = {};
    this._ids = {};

    this._running = false;
}

HyperG.prototype.run = function() {
    var self = this;

    if (self._running) return;
    self._running = true;

    self.tx_network.on('connection', (connection, info) => {
        self._read(connection, 64, hash => {

            if (hash in self._uploads) {
                var archive = self._uploads[hash];
                if (!archive) return connection.close();

                console.info("Hyperdrive: uploading", archive.key.toString('hex'));

                connection.pipe(archive.replicate({
                    download: false,
                    upload: true
                })).pipe(connection);
            } else
                console.error('Hyperdrive: unknown hash requested', hash);
        });
    });

    self.tx_network.on('error', error => {
        console.error('Error:', error);
        self.exit();
    });

    self.tx_network.on('listening', () => {
        console.info("Hyperdrive is ready");
    });

    self.expose_rpc();
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

                console.info("Hyperdrive: sharing", hash);

                self._uploads[hash] = archive;
                self.tx_network.join(archive.discoveryKey);
                cb(hash);
            }
        });
    });
}

HyperG.prototype.download = function(hash, destination) {
    /* Create one network per download */

    var self = this;
    var network = self._create_network();
    network.listen(0);

    self.rx_networks[hash + destination] = network;
    console.info("Hyperdrive: downloading", hash);

    return new Promise((cb, eb) => {
        var archive = self.hyperdrive.createArchive(hash);
        network.once('connection', (connection, info) => {
            self._on_download_connection(connection, info, archive,
                                         destination, cb, eb);
        });
        network.join(archive.discoveryKey);
    });
}

HyperG.prototype._on_download_connection = function(connection, info, archive,
                                                    destination, callback, errback) {
    var files = [];

    connection.write(archive.key.toString('hex'));
    connection.pipe(archive.replicate({
        download: true,
        upload: false
    })).pipe(connection);

    Archiver.get(archive, destination, (file, error, left) => {
        files.push(file);

        if (error) errback(error);
        if (left <= 0) callback(files);
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


HyperG.prototype.cancel_upload = function(hash) {
    var exists = hash in self._uploads;
    if (exists) {
        console.info("Hyperdrive: cancelling", hash);
        delete self._uploads[hash];
        self.tx_network.leave(hash);
    }
    return exists;
}

HyperG.prototype.expose_rpc = function(port, host) {
    host = host || '127.0.0.1';
    this.rpc = new RPC(this, port, host);
    this.rpc.listen();
}

HyperG.prototype.exit = function(message, code) {
    if (message)
        console.error(message);

    try {
        for (var key in self.rx_networks) {
            if (self.rx_networks.hasOwnProperty(key))
                self.rx_networks[key].close();
        }

        self.tx_network.close();
        self.db.close();
    } catch (e) {
        console.error(e.message);
    }

    process.exit(code);
}

HyperG.prototype._create_network = function() {
    var network = discovery(defaults(this.options));
    network.on('error', error => {
        console.error(error);
    });
    return network;
}

HyperG.prototype._can_recover = function(error) {
    // TODO: implement
    return false;
}

module.exports = HyperG;
