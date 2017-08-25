const ip = require('ip');
const logger = require('./logger').logger;


const id = peer => peer.host + ':' + peer.port;

const oneShot = func => {
    var result = function() {
        let f = this.func;
        this.func = () => {};
        return f.apply(null, arguments);
    };

    result.func = func;
    return result;
};


function PeerConnector(swarm, key, eb) {
    this.swarm = swarm;
    this.channel = key;
    this.eb = oneShot(eb);

    this.peers = new Set();
    this.dropped = 0;

    this.swarm.on('drop', peer => {
        let exists = this.peers.has(id(peer));
        if (exists && ++this.dropped == this.peers.size)
            this.eb('Cannot connect to provided peers');
    });
}

PeerConnector.prototype.connect = function(peers) {
    try {
        peers = (peers || []).map(p => ({
            host: p.TCP.address,
            port: p.TCP.port
        }));

        logger.debug('Connecting to peers', this.key, peers);
        peers.forEach(this._validate);
        peers.forEach(this._connect);
    } catch (exc) {
        this.eb(exc.message);
    }
};

PeerConnector.prototype._connect = function(peer) {
    let peerId = id(peer);
    if (this.peers.has(peerId))
        return;

    this.peers.add(peerId);
    this.swarm._discovery.emit('peer', this.channel, peer, 'dht');
};

PeerConnector.prototype._validate = function(peer) {
    let host = peer.host;
    let port = peer.port;

    if (!ip.isV4Format(host) && !ip.isV6Format(host))
        throw new Error('Invalid address:', host);
    if (port < 1 || port > 65535)
        throw new Error('Invalid port:', port);
};


module.exports = {
    PeerConnector: PeerConnector
};
