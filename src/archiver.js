const encoding = require('hyperdrive-encoding')
const eos = require('end-of-stream');
const fs = require('fs');
const hash = require('hypercore/lib/hash');
const mkdirp = require('mkdirp');
const path = require('path');
const pump = require('pump');

const logger = require('./logger');

const Feed = require('hypercore/lib/feed');
const Hyperdrive = require('hyperdrive');
const Level = require('level');
const Subleveldown = require('subleveldown');

/* Error codes */
const ERR_NONE = null,
      ERR_NOT_FOUND = 1,
      ERR_FEED_OPEN = 2;

/* Storage options */
const MAX_PEER_AGE = 7 * 24 * 3600 * 1000;

/* Path regular expressions */
const rel_re = /^(\.\.[\/\\])+/;
const path_re = /\/|\\/;


function Entries() {}

function Archiver(options, streamOptions) {
    const dir = path.dirname(options.db);
    if (!fs.existsSync(dir))
        mkdirp.sync(dir);

    this.db = Level(options.db);
    this.drive = Hyperdrive(this.db);
    this.keys = Subleveldown(this.db, 'keys', { 
        valueEncoding: 'binary'
    });

    this.callbacks = {};
    
    this.streamOptions = Object.assign({
        timeout: 5000,
        maxListeners: 0
    }, streamOptions || {});
}


Archiver.prototype.id = function() {
    return this.drive.core.id;
}

Archiver.prototype.want = function(key, onArchive, cb) {
    var self = this;

    self.get(key, (error, archive) => {
        if (archive) return onArchive(null, archive);

        this.callbacks[key] = this.callbacks[key] || [];
        this.callbacks[key].push(onArchive);
        this.createFeed(key);
        cb();
    });
}

Archiver.prototype.unwant = function(key, cb) {
    this.callbacks[key] = this.callbacks[key].filter(c => c != cb);
}

Archiver.prototype.get = function(key, cb) {
    var self = this;
    var feeds = self.drive.core._feeds;

    self.keys.get(key, (error, discoveryKey) => {
        if (error) return cb(error);

        feeds.get(discoveryKey, (error, feed) => {
            if (error) return cb(error);
            cb(null, self.createArchive(key, feed));
        });
    });
}

Archiver.prototype.create = function(files, cb) {
    var self = this;
    var archive = this.createArchive();

    Entries.add(archive, files, (error, files) => {
        if (error) return cb(error);
        const key = archive.key.toString('hex');
        const discoveryKey = archive.discoveryKey.toString('hex');
        self.addKey(archive, error => cb(error, files));
    });
}

Archiver.prototype.remove = function(key, cb) {
    var self = this;
    var feeds = self.drive.core._feeds;

    self.keys.get(key, (error, discoveryKey) =>
        self.keys.del(key, null, error => {

            if (error) return cb(error);
            feeds.del(discoveryKey, null, error =>
                cb(error, discoveryKey)
            );
        })
    )
}

Archiver.prototype.replicate = function(peer) {
    var self = this;
    var feeds = self.drive.core._feeds;
    var stream = self.drive.core.replicate();

    stream.setMaxListeners(self.streamOptions.maxListeners);
    stream.setTimeout(self.streamOptions.timeout, stream.destroy);
    /* Respond to other side's request */
    stream.on('open', discoveryBuffer => {
        const discoveryKey = discoveryBuffer.toString('hex');

        feeds.get(discoveryKey, (error, feed) => {
            if (error) return;
            feed = self.createFeed(feed);
            self.open(feed.key, true, stream, feed);
        });
    });
    /* Request all keys blindly */
    for (let key in self.callbacks)
        self.open(buffer(key), true, stream, null, key);

    return stream;
}

Archiver.prototype.open = function(keyBuffer, maybeContent, stream, feed, key) {
    var self = this;

    feed = feed || this.createFeed(keyBuffer);
    if (!maybeContent)
        feed.on('download-finished', () => self.replicationFinished(key));
    feed.replicate({ stream: stream });

    const close = () => feed.close();
    if (stream.destroyed)
        close();
    else
        eos(stream, close);

    if (maybeContent)
        feed.get(0, (error, data) => {
            if (self.decodeContent(stream, error, data, key))
                return;
            if (feed.blocks)
                feed.get(feed.blocks - 1, (error, data) =>
                    self.decodeContent(stream, error, data, key)
                );
        });

    return feed;
}

Archiver.prototype.decodeContent = function(stream, error, data, key) {
    if (error) return false;

    var feedKey;
    try {
        var index = encoding.decode(data);
        if (index.type === 'index' &&
            index.content &&
            index.content.length === 32)
            feedKey = index.content;
    } catch (err) {}

    if (feedKey) {
        this.createFeed(feedKey);
        this.open(feedKey, false, stream, null, key);
    }
    return !!feedKey;
}

Archiver.prototype.addKey = function(feed, cb) {
    const key = feed.key.toString('hex');
    const discoveryKey = feed.discoveryKey.toString('hex');

    this.keys.put(key, discoveryKey, { sync: true }, err =>
        cb ? cb(err) : null
    );
}

Archiver.prototype.replicationFinished = function(key, error) {
    var self = this;
    var callbacks = self.callbacks[key];

    if (!callbacks) return;
    delete self.callbacks[key];
    
    self.get(key, (error, archive) =>
        self.replicationCallbacks(callbacks, error, archive)
    );
}

Archiver.prototype.replicationCallbacks = function(callbacks, error, data) {
    asyncEach(callbacks, (callback, next) => {
        try {
            callback(error, data);
        } catch (exc) {
            logger.error('Error in replication callback', exc);
        } next();
    });
}

Archiver.prototype.createFeed = function(mixed) {
    var feed;

    if (Buffer.isBuffer(mixed) || typeof(mixed) == 'string') {
        feed = Feed(this.drive.core, { 
            key: buffer(mixed),
            valueEncoding: this.drive.core._valueEncoding
        });
        this.addKey(feed);
    } else {
        feed = Feed(this.drive.core, Object.assign({}, { 
            key: buffer(mixed.key),
            valueEncoding: this.drive.core._valueEncoding
        }, mixed));
        feed.prefix = mixed.prefix;
    }

    return feed;
}

Archiver.prototype.createArchive = function(key, feed) {
    return this.drive.createArchive(key, { metadata: feed });
}

Archiver.prototype.save = function(archive, destination, cb) {
    Entries.save(archive, destination, cb);
}


Entries.path = function(entry, destination) {
    const name = entry.hasOwnProperty('name') ? entry.name : entry;
    const joined = path.join.apply(path, name.split(path_re));
    const relative  = path.normalize(joined).replace(rel_re, '');
    return path.join(destination, relative);
}

Entries.map = function(entries, destination) {
    var paths = {};

    for (let entry of entries)
        try {
            if (Entries.is_file(entry))
                paths[entry.name] = Entries.path(entry, destination);
        } catch (e) {
            logger.error('Entry path mapping error:', e);
        }

    return paths;
}

Entries.save = function(archive, destination, cb) {
    archive.list(null, (error, entries) => {
        if (error) return cb(error);

        const paths = Entries.map(entries, destination);
        const files = Object.keys(paths).map(k => paths[k]);

        asyncEach(entries, (entry, next, left) => {
            if (!Entries.is_file(entry)) return next();

            const dest = paths[entry.name];
            logger.debug('Saving', entry.name, '=>', dest);

            if (Entries.exists(archive, entry, dest)) {
                if (left) return next();
                return cb(null, files);
            }

            try {
                mkdirp.sync(path.dirname(dest));
            } catch (error) {
                return cb(error);
            }

            var rs = archive.createFileReadStream(entry);
            var ws = fs.createWriteStream(dest);

            rs.on('error', err =>
                logger.error('ReadStream error [save]:', err));
            ws.on('error', err =>
                logger.error('WriteStream error [save]:', err));

            pump(rs, ws, error => {
                if (error)      cb(error);
                else if (!left) cb(ERR_NONE, files);
                else            next();
            });
        });
    });
}

Entries.add = function(archive, files, cb) {
    asyncEach(files, (file, next, left) => {
        const source = file[0];
        const name = file[1];

        var rs = fs.createReadStream(source);
        var ws = archive.createFileWriteStream({ name: name });

        rs.on('error', err =>
            logger.error('ReadStream error [archive]:', err));
        ws.on('error', err =>
            logger.error('WriteStream error [archive]:', err));

        pump(rs, ws, error => {
            if (error)      cb(error);
            else if (!left) cb(ERR_NONE, archive);
            else            next();
        });
    });
}

Entries.exists = function(archive, entry, path) {
    return archive.isEntryDownloaded(entry) &&
           fs.existsSync(path);
}

Entries.is_file = function(entry) {
    return entry && entry.type == 'file' && entry.name;
}


function buffer(value) {
    if (Buffer.isBuffer(value))
        return value;
    return Buffer(value, 'hex');
}


function asyncEach(source, fn) {
    var items = source.slice();
    var next = error => {
        if (error || !items.length) return;
        setTimeout(() => fn(items.shift(),
                            next,
                            items.length), 0);
    }; next();
}


module.exports = Archiver;
