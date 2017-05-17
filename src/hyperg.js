const fs = require('fs');
const mkdirp = require('mkdirp');
const path = require('path');
const uuid = require('uuid/v4');
const hash = require('hypercore/lib/hash');
const toBuffer = require('to-buffer');

const Swarm = require('discovery-swarm');
const SwarmDefaults = require('datland-swarm-defaults');

const Archiver = require('./archiver');
const RPC = require('./rpc');

const common = require('./common');
const logger = require('./logger');

/* Unlimited event listeners */
process.setMaxListeners(0);
/* Log SIGPIPE errors */
process.on('SIGPIPE', () =>
    logger.error("broken pipe"));


function HyperG(options) {
    var self = this;

    self.options = Object.assign({
        host: '0.0.0.0',
        port: 3282,
        rpc_host: 'localhost',
        rpc_port: 3292,
        db: './' + common.application + '.db'
    }, options);

    self.archiver = new Archiver(self.options);
    self.rpc = new RPC(self, self.options.rpc_port,
                             self.options.rpc_host);

    self.swarmOptions = {
        utp: true,
        tcp: true,
        dht: true,
        dns: true,
        hash: false
    }

    self.swarm = new Swarm(new SwarmDefaults(
        Object.assign({}, self.swarmOptions, {
            stream: peer =>
                self.archiver.replicate(peer)
        })
    ));

    self.running = false;
}

HyperG.exit = function(message, code) {
    if (message) {
        code = code || 1;
        logger.error(message);
    }
    process.exit(code);
}

HyperG.prototype.id = function() {
    return this.archiver.id();
}

HyperG.prototype.run = function() {
    var self = this;

    if (self.running) return;
    self.running = true;

    self.swarm.once('error', HyperG.exit);
    self.swarm.once('listening', () =>
        self.rpc.listen(self.options.rpc_port,
                        self.options.rpc_host)
            .then(() => {
                var addresses = self.addresses(self.swarm);

                logger.info(common.application,
                            '[' + common.version + ']');

                if ('TCP' in addresses)
                    logger.info('TCP listening on',
                                addresses.TCP.address +
                                ':' +
                                addresses.TCP.port);

                if ('UTP' in addresses)
                    logger.info('UTP listening on',
                                addresses.UTP.address +
                                ':' +
                                addresses.UTP.port);
            }, HyperG.exit)
    );

    self.swarm.listen({
        host: self.options.host,
        port: self.options.port,
        id: self.id()
    });
}

HyperG.prototype.upload = function(id, files, discoveryKey) {
    if (discoveryKey)
        return this.uploadArchive(discoveryKey);
    return this.uploadFiles(files);
}

HyperG.prototype.uploadFiles = function(files) {
    var self = this;

    return new Promise((cb, eb) => {
        self.archiver.create(files, (error, archive) => {
            if (error) return eb(error);

            archive.finalize(error => {
                if (error) return eb(error);
                var key = archive.key.toString('hex');
                self.swarm.join(archive.discoveryKey);

                logger.info('Sharing', key);
                cb(key);
            });

        });
    });
}

HyperG.prototype.uploadArchive = function(key) {
    var self = this;
    var discoveryKey = hash.discoveryKey(key).toString('hex');

    return new Promise((cb, eb) =>
        self.archiver.stat(discoveryKey, error => {
            if (error) return eb(error);

            logger.info("Sharing (cached)", key);
            self.swarm.join(discoveryKey);
            cb(key);
        })
    );
}

HyperG.prototype.download = function(key, destination) {
    var self = this;
    var archive = self.archiver.drive.createArchive(key);

    var options = Object.assign({}, self.swarmOptions, {
        stream: peer => archive.replicate()
    });

    var downloadSwarm = new Swarm(new SwarmDefaults(options));
    HyperG._patch_join(downloadSwarm);

    return new Promise((cb, eb) => {

        const onOpen = error => {
            if (error) return eb(error);

            const onCopy = (error, files) => {
                if (error) return eb(error);

                archive.finalize(() => archive.close(() => {
                    logger.info('Downloaded', key);
                    downloadSwarm.leave(archive.discoveryKey);
                    self.closeSwarm(downloadSwarm);
                    cb(files);
                }));
            }

            self.archiver.copyArchive(archive, destination,
                                      onCopy);
        }

        downloadSwarm.once('error', eb);
        downloadSwarm.once('listening', () => {
            logger.info("Looking up", key);

            var addresses = self.addresses(downloadSwarm);
            if ('TCP' in addresses)
                logger.debug('TCP swarm', key,
                             addresses.TCP.address + ':' +
                             addresses.TCP.port);
            if ('UTP' in addresses)
                logger.debug('UTP swarm', key,
                             addresses.UTP.address + ':' +
                             addresses.UTP.port);

            downloadSwarm.join(archive.discoveryKey);
            archive.open(onOpen);
        });

        downloadSwarm.listen({
            host: self.options.host,
            port: 0
        });
    });
}

HyperG.prototype.addresses = function(swarm) {
    const serverAddress = server => {
        var address = server.address();
        return {
            address: address.address,
            port: address.port
        };
    }

    var result = {};
    if (swarm._tcp)
        result.TCP = serverAddress(swarm._tcp);
    if (swarm._utp)
        result.UTP = serverAddress(swarm._utp);
    return result;
}

HyperG.prototype.cancel = function(key) {
    var self = this;
    var discoveryKeyBuffer = hash.discoveryKey(key);

    return new Promise((cb, eb) => {
        var discoveryKey = discoveryKeyBuffer.toString('hex');
        // FIXME: close active connections
        self.swarm.leave(discoveryKeyBuffer);
        // FIXME: remove actual data
        self.archiver.remove(discoveryKey, error => {
            if (error) return eb(error);
            logger.info("Canceling", key);
            cb(key);
        });
    });
}

// FIXME: close servers
HyperG.prototype.closeSwarm = function(swarm) {
    if (swarm._discovery) {
        swarm._kick = nop;
        swarm._discovery.destroy()
    }

    if (swarm._utp) {
        swarm._utp.connect = nop;
        for (var conn of swarm._utp.connections)
            conn.destroy()
        // swarm._utp.close();
    }

    if (swarm._tcp) {
        swarm._tcp.connect = nop;
        swarm._tcpConnections.destroy()
        // swarm._tcp.close();
    }
}

HyperG._patch_join = function(swarm) {
    const join = function(name) {
        name = toBuffer(name)

        if (!this._listening && !this._adding)
            this._listenNext();

        if (this._adding)
            this._adding.push(name);
        else
            this._discovery.join(name, null, {
                impliedPort: !!this._utp
            });
    }

    swarm.join = join.bind(swarm);
}


const nop = () => {};

module.exports = HyperG;
