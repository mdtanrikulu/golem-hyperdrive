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
const logger = require('./logger').logger;
const winston = require('winston');

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
        utp: common.features.utp === true,
        tcp: true,
        hash: false
    };

    self.swarm = new Swarm(new SwarmDefaults(
        Object.assign({}, self.swarmOptions, {
            stream: peer =>
                self.archiver.replicate(peer)
        })
    ));

    self.networks = [];
    self.running = false;
}

HyperG.exit = function(message, code) {
    if (message) {
        code = code || 1;
        logger.error(message);
    }
    process.exit(code);
};

HyperG.prototype.id = function() {
    return this.archiver.id();
};

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

                if ('uTP' in addresses)
                    logger.info('uTP listening on',
                                addresses.uTP.address +
                                ':' +
                                addresses.uTP.port);
            }, HyperG.exit)
    );

    self.logSwarmEvents(self.swarm, '[Upload]');
    self.swarm.listen({
        host: self.options.host,
        port: self.options.port
    });
};

HyperG.prototype.upload = function(id, files, discoveryKey) {
    if (discoveryKey)
        return this.uploadArchive(discoveryKey);
    return this.uploadFiles(files);
};

HyperG.prototype.uploadFiles = function(files) {
    var self = this;

    return new Promise((cb, eb) => {
        eb = loggingEb(eb);

        self.archiver.create(files, (error, archive) => {
            if (error) return eb(error);

            archive.finalize(error => {
                if (error) return eb(error);

                const key = archive.key.toString('hex');
                self.swarm.join(archive.discoveryKey);

                logger.info('Sharing', key);
                cb(key);
            });

        });
    });
};

HyperG.prototype.uploadArchive = function(key) {
    var self = this;

    const discoveryBuffer = discovery(key);
    const discoveryKey = discoveryBuffer.toString('hex');

    return new Promise((cb, eb) => {
        eb = loggingEb(eb);

        self.archiver.stat(discoveryKey, error => {
            if (error) return eb(error);

            logger.info("Sharing (cached)", key);
            self.swarm.join(discoveryKey);
            cb(key);
        });
    });
};

HyperG.prototype.download = function(key, destination) {
    var self = this;
    var archive = self.archiver.drive.createArchive(key);

    var options = Object.assign({}, self.swarmOptions, {
        id: archive.id || discovery(key),
        stream: peer => archive.replicate({
            download: true,
            upload: false
        })
    });

    var downloadSwarm = new Swarm(new SwarmDefaults(options));

    return new Promise((cb, eb) => {
        eb = loggingEb(eb);

        const onOpen = error => {
            if (error) return eb(error);

            logger.debug('Saving files', key);
            self.archiver.copyArchive(archive, destination,
                                      (error, files) => {
                if (error) return eb(error);

                logger.info('Downloaded', key);
                cb(files);

                downloadSwarm.leave(archive.discoveryKey);
                archive.close(() => {
                    logger.debug('Closing swarm', key);
                    self.closeSwarm(downloadSwarm);
                });
            });
        };

        downloadSwarm.once('error', eb);
        downloadSwarm.once('listening', () => {
            var addresses = self.addresses(downloadSwarm);

            if ('TCP' in addresses)
                logger.debug('TCP swarm', key,
                             addresses.TCP.address + ':' +
                             addresses.TCP.port);
            if ('uTP' in addresses)
                logger.debug('uTP swarm', key,
                             addresses.uTP.address + ':' +
                             addresses.uTP.port);

            logger.info("Looking up", key);
            downloadSwarm.join(archive.discoveryKey);
            archive.open(onOpen);
        });

        self.logSwarmEvents(downloadSwarm, '[Download]');
        downloadSwarm.listen({
            host: self.options.host,
            port: 0
        });
    });
};

HyperG.prototype.addresses = function(swarm) {
    const serverAddress = server => {
        var address = server.address();
        return {
            address: address.address,
            port: address.port
        };
    };

    var result = {};
    if (swarm._tcp)
        result.TCP = serverAddress(swarm._tcp);
    if (swarm._utp)
        result.uTP = serverAddress(swarm._utp);
    return result;
};

HyperG.prototype.cancel = function(key) {
    var self = this;

    const discoveryBuffer = discovery(key);
    const discoveryKey = discoveryBuffer.toString('hex');

    return new Promise((cb, eb) => {
        eb = loggingEb(eb);
        self.swarm.leave(discoveryBuffer);
        self.archiver.remove(discoveryKey, error => {
            if (error) return eb(error);
            logger.info("Canceling", key);
            cb(key);
        });
    });
};


/* FIXME: proper teardown */
HyperG.prototype.closeSwarm = function(swarm) {
    if (swarm._discovery) {
        swarm._kick = nop;
        swarm._discovery.destroy();
    }

    if (swarm._utp) {
        swarm._utp.connect = nop;
        /* FIXME: proper teardown
        for (var conn of swarm._utp.connections)
            conn.destroy()
        swarm._utp.close();*/
    }

    if (swarm._tcp) {
        swarm._tcp.connect = nop;
        swarm._tcpConnections.destroy();
        swarm._tcp.close();
    }
};

HyperG.prototype.logSwarmEvents = function(swarm, postfix) {
    swarm.on('peer', peer =>
        logger.debug('Peer discovery', postfix,
                     normalizePeer(peer))
    );
    swarm.on('drop', peer =>
        logger.debug('Dropping peer', postfix,
                     normalizePeer(peer))
    );
    swarm.on('connecting', peer =>
        logger.debug('Connecting to peer', postfix,
                     normalizePeer(peer))
    );
    swarm.on('connection', (connection, info) => {
        logger.debug('New connection', postfix, info);

        connection.on('handshake', remoteId =>
            logger.debug('Handshake with peer', postfix, remoteId)
        );
        connection.on('close', () =>
            logger.debug('Connection closed', postfix, info)
        );
        connection.on('error', error =>
            logger.debug('Connection error', postfix, error)
        );
    });
};

function buffer(value) {
    if (Buffer.isBuffer(value))
        return value;
    return new Buffer(value, 'hex');
}

function discovery(value) {
    return hash.discoveryKey(buffer(value));
}

function loggingEb(eb) {
    return error => {
        logger.error(error);
        eb(error);
    };
}

function normalizePeer(peer) {
    if (peer && peer.channel)
        return Object.assign({}, peer, {
            channel: peer.channel.toString('hex')
        });
    return peer;
}

const nop = () => {};

module.exports = HyperG;
