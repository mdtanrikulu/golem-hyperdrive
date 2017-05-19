const fs = require('fs');
const mkdirp = require('mkdirp');
const path = require('path');
const uuid = require('uuid/v4');
const hash = require('hypercore/lib/hash');
const toBuffer = require('to-buffer');

const Swarm = require('discovery-swarm');
const SwarmDefaults = require('datland-swarm-defaults');

const Leveldown = require('leveldown');
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

    self.running = false;
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
    };
    self.swarm = new Swarm(new SwarmDefaults(
        Object.assign({}, self.swarmOptions, {
            stream: peer =>
                self.archiver.replicate(peer)
        })
    ));
}

HyperG.prototype.run = function() {
    var self = this;
    if (self.running) return;
    self.running = true;

    self.swarm.once('error', self.exit);
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
    /* Bind to port and start discovery */
    self.swarm.listen({
        host: self.options.host,
        port: self.options.port,
        id: self.id()
    });
}

HyperG.prototype.exit = function(message, code) {
    if (message) {
        code = code || 1;
        logger.error(message);
    }
    process.exit(code);
}

HyperG.prototype.id = function() {
    return this.archiver.id();
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

HyperG.prototype.download = function(key, destination) {
    var self = this;
    const keyBuffer = Buffer(key, 'hex');
    const discoveryKey = hash.discoveryKey(keyBuffer);

    return new Promise((cb, eb) => {
        /* When archive is created / read from db */
        const onArchive = (error, archive) => {
            if (error) return eb(error);
            /* Save files to dest dir */
            logger.info('Downloaded', key);
            self.archiver.save(archive, destination, (error, files) => {
                if (error) eb(error);
                else       cb(files);
            });
        };
        /* Download or copy existing archive */
        self.archiver.want(key, onArchive, () => {
            logger.info('Downloading', key);
            /* Join discovery for key*/
            self.swarm.join(discoveryKey)
        });
    });
}

HyperG.prototype.upload = function(id, files) {
    var self = this;

    return new Promise((cb, eb) => {
        /* Create a new archive with listed files */
        self.archiver.create(files, (error, archive) => {
            if (error) return eb(error);
            /* Finalize the archive before sharing */
            archive.finalize(error => {
                if (error) return eb(error);
                /* Announce key */
                self.swarm.join(archive.discoveryKey);
                /* Callback */
                const key = archive.key.toString('hex');
                logger.info('Sharing', key); 
                cb(key);
            });
        });
    });
}

HyperG.prototype.cancel = function(key) {
    var self = this;
    var discoveryBuffer = hash.discoveryKey(key);

    return new Promise((cb, eb) => {
        var discoveryKey = discoveryBuffer.toString('hex');
        /* Unannounce the key */
        self.swarm.leave(discoveryBuffer);
        /* Remove data */
        self.archiver.remove(discoveryKey, error => {
            if (error) return eb(error);
            /* Callback */
            logger.info("Canceling", key);
            cb(key);
        });
    });
}


module.exports = HyperG;
