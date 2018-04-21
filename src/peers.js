const ip = require('ip');
const logger = require('./logger').logger;


const toObject = entry => ({
    host: entry.TCP[0],
    port: parseInt(entry.TCP[1]) || null
});

const toId = peer => peer.host + ':' + peer.port;

const filter = peer => {
    let host = peer.host;
    let port = peer.port;

    if (!ip.isV4Format(host) && !ip.isV6Format(host))
        return false;
    if (port < 1 || port > 65535)
        return false;
    return true;
}


function PeerConnector(swarm, key, eb) {
    this.swarm = swarm;
    this.channel = key;
    this.peers = new Set();
    this.dropped = 0;

    this.eb = error => {
        logger.error(error);
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
        let converted = (peers || []).map(toObject);
        let filtered = converted.filter(filter);

        if (!filtered || filtered.length == 0)
            throw new Error("Invalid peers: " + JSON.stringify(peers));

        logger.info('Connecting to peers', this.channel, filtered);
        filtered.forEach(peer => this._connect(peer));
    } catch (exc) {
        exc.message = exc.message || exc.name || String(exc);
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
