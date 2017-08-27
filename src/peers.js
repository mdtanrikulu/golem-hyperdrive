const ip = require('ip');
const logger = require('./logger').logger;


const toId = peer => peer.host + ':' + peer.port;
const toObject = entry => ({
    host: entry.TCP[0],
    port: parseInt(entry.TCP[1])
});

const oneShot = func => {
    var result = function() {
        if (this.func) {
            let f = this.func;
            this.func = null;
            return f.apply(null, arguments);
        }
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
        let exists = this.peers.has(toId(peer));
        if (exists && ++this.dropped == this.peers.size)
            this.eb('Cannot connect to provided peers');
    });
}

PeerConnector.prototype.connect = function(peers) {
    try {
        logger.debug('Connecting to peers', this.key, peers);

        peers = (peers || []).map(toObject);
        peers.forEach(this._validate);
        peers.forEach(this._connect);
    } catch (exc) {
        this.eb(exc.message);
    }
};

PeerConnector.prototype._connect = function(peer) {
    let peerId = toId(peer);
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
