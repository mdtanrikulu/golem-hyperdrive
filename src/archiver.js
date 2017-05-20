const encoding = require('hyperdrive-encoding')
const eos = require('end-of-stream');
const fs = require('fs');
const hash = require('hypercore/lib/hash');
const mkdirp = require('mkdirp');
const path = require('path');
const pump = require('pump');

const Feed = require('hypercore/lib/feed');
const Hyperdrive = require('hyperdrive');
const Level = require('level');

const logger = require('./logger');

/* Error codes */
const ERR_NONE = null,
      ERR_NOT_FOUND = 1,
      ERR_FEED_OPEN = 2;

/* Path regular expressions */
const rel_re = /^(\.\.[\/\\])+/;
const path_re = /\/|\\/;


function FeedTracker(create) {
    this.create = create;
    this.feeds = {};
}

FeedTracker.prototype.open = function(key, feed) {
    const discoveryKey = discovery(key);
    this.feeds[discoveryKey] = this.feeds[discoveryKey] || {
        count: 0,
        feed: feed || this.create(key)
    };

    this.feeds[discoveryKey].count += 1;
    return this.feeds[discoveryKey].feed;
}

FeedTracker.prototype.close = function(feed) {
    const discoveryKey = feed.discoveryKey.toString('hex');
    if (--this.feeds[discoveryKey].count <= 0) {
        delete this.feeds[discoveryKey];
        feed.close();
    }
}


function Archiver(options, streamOptions) {
    if (!fs.existsSync(options.db))
        mkdirp.sync(options.db);

    this.db = new Level(options.db);
    this.drive = new Hyperdrive(this.db);
    this.feedTracker = new FeedTracker(mixed =>
        this.createFeed(mixed)
    );

    this.keys = {};
    this.callbacks = {};

    this.options = options;
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
        this.keys[discovery(key)] = key;

        cb();
    });
}

Archiver.prototype.unwant = function(key, cb) {
    if (this.callbacks[key])
        this.callbacks[key] =
            this.callbacks[key].filter(c => c != cb);
}

Archiver.prototype.get = function(key, cb, asFeed) {
    var self = this;
    var feeds = self.drive.core._feeds;

    feeds.get(discovery(key), (error, feed) => {
        if (error) return cb(error);
        var result = asFeed
            ? self.createFeed(feed)
            : self.createArchive(key, feed);
        cb(ERR_NONE, result);
    });
}

Archiver.prototype.create = function(files, cb) {
    var self = this;
    var archive = this.createArchive();

    Entries.add(archive, files, (error, files) => {
        if (error) return cb(error);
        cb(ERR_NONE, files);
    });
}

Archiver.prototype.remove = function(key, cb) {
    var self = this;
    var feeds = self.drive.core._feeds;

    feeds.del(discovery(key), null, error =>
        cb(error, key)
    );
}

Archiver.prototype.save = function(archive, destination, cb) {
    Entries.save(archive, destination, cb);
}

Archiver.prototype.replicate = function(peer) {
    var self = this;
    var feeds = self.drive.core._feeds;
    var stream = self.drive.core.replicate();

    stream.setMaxListeners(self.streamOptions.maxListeners);
    stream.setTimeout(self.streamOptions.timeout, stream.destroy);
    stream.openForReplication = false;

    /* Respond to other side's request */
    stream.on('open', discoveryBuffer => {
        stream.openForReplication = true;

        const discoveryKey = discoveryBuffer.toString('hex');
        const onFeed = (error, feed) => {
            if (error)
                return;

            var key = feed.key.toString('hex');
            var feed = self.createFeed(feed);

            logger.debug('Replicate', key);
            self.open(key, true, stream, key, feed);
        }

        feeds.get(discoveryKey, onFeed);
    });

    /* Request feeds */
    setTimeout(() => {
        if (peer.channel) {
            const discoveryKey = peer.channel.toString('hex');
            const key = self.keys[discoveryKey];
            if (key && !stream.openForReplication) {
                logger.debug('Direct connection',
                            `${peer.host}:${peer.port}`, key);
                return self.open(key, true, stream, key);
            }
        }
    }, 0);

    return stream;
}

Archiver.prototype.open = function(curKey, maybeContent, stream, parent, feed) {
    var self = this;

    feed = self.feedTracker.open(curKey, feed);
    parent = typeof(parent) === 'object' ? parent : feed;

    feed.once('download-finished', () => {
        if (!maybeContent || parent != feed) {
            if (!parent.content) parent.content = feed;
            self.replicationFinished(parent.key.toString('hex'));
        }
    });

    feed.replicate({ stream: stream });

    if (stream.destroyed)
        self.feedTracker.close(feed);
    else
        eos(stream, () => self.feedTracker.close(feed));

    if (!maybeContent)
        return feed;

    feed.get(0, (error, data) => {
        if (self.decodeContent(error, stream, data, parent))
            return;
        if (feed.blocks) {
            feed.get(feed.blocks - 1, (error, data) =>
                self.decodeContent(error, stream, data, parent)
            );
        }
    });

    return feed;
}

Archiver.prototype.decodeContent = function(error, stream, data, parent) {
    var key = error ? null : this.feedKey(data);
    if (key) this.open(key, false, stream, parent);
    return !!key;
}

Archiver.prototype.feedKey = function(data) {
    try {
        var index = encoding.decode(data);
        if (index.type === 'index' &&
            index.content &&
            index.content.length === 32)
            return index.content;
    } catch (err) {}
}

Archiver.prototype.replicationFinished = function(key, error) {
    var self = this;
    var callbacks = self.callbacks[key];

    delete self.callbacks[key];
    if (!callbacks) return;

    logger.debug('Replication finished', key)
    self.get(key, (error, archive) =>
        self.replicationCallbacks(callbacks, error, archive)
    );
}

Archiver.prototype.replicationCallbacks = function(callbacks, error, data) {
    asyncEach(callbacks, (callback, next) => {
        try { callback(error, data) } catch (exc) {}
        next();
    });
}

Archiver.prototype.createFeed = function(mixed) {
    const fromString = typeof(mixed) === 'string' ||
        Buffer.isBuffer(mixed);

    var feed = null;
    var feedOptions = {
        key: fromString ? buffer(mixed) : mixed.key,
        valueEncoding: this.drive.core._valueEncoding
    };

    if (fromString) {
        feed = Feed(this.drive.core, feedOptions);
    } else {
        feedOptions = Object.assign(feedOptions, mixed);
        feed = Feed(this.drive.core, feedOptions, mixed);
        feed.prefix = mixed.prefix;
    }

    return feed;
}

Archiver.prototype.createArchive = function(key, feed) {
    return this.drive.createArchive(key, { metadata: feed });
}


function Entries() {}


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
                return cb(ERR_NONE, files);
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

function discovery(key) {
    return hash.discoveryKey(buffer(key))
        .toString('hex');
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
