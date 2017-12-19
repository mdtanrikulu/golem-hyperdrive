const ip = require('ip');
const logger = require('./logger').logger;


const toObject = entry => ({
    host: entry.TCP[0],
    port: parseInt(entry.TCP[1])
});

const toId = peer => peer.host + ':' + peer.port;

const validate = peer => {
    let host = peer.host;
    let port = peer.port;

    if (!ip.isV4Format(host) && !ip.isV6Format(host))
        throw new Error('Invalid address:', host);
    if (port < 1 || port > 65535)
        throw new Error('Invalid port:', port);
}


function PeerConnector(swarm, key, eb) {
    this.swarm = swarm;
    this.channel = key;
    this.peers = new Set();
    this.dropped = 0;

    this.eb = error => {
        this.eb = logger.error;
        eb(error);
    };

    this.swarm.on('drop', peer => {
        let exists = this.peers.has(toId(peer));
        if (exists && ++this.dropped == this.peers.size)
            this.eb('Cannot connect to provided peers');
    });
}

PeerConnector.prototype.connect = function(peers) {
    try {
        logger.debug('Connecting to peers', this.channel, peers);
        peers = (peers || []).map(toObject);
        peers.forEach(validate);
        peers.forEach(peer => this._connect(peer));
    } catch (exc) {
        this.eb(exc.message);
    }
};

PeerConnector.prototype._connect = function(peer) {
    let id = toId(peer);
    if (this.peers.has(id))
        return;

    peer.id = id;
    peer.retries = 0;
    peer.channel = this.channel;

    this.peers.add(id);
    this.swarm.addPeer(new Buffer(this.channel, 'hex'), peer);
};


module.exports = PeerConnector;
