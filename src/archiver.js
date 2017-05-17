const fs = require('fs');
const mkdirp = require('mkdirp');
const path = require('path');
const pump = require('pump');

const logger = require('./logger');

const Feed = require('hypercore/lib/feed');
const Hyperdrive = require('hyperdrive');
const Level = require('level');

/* Error codes */
const ERR_NONE = null,
      ERR_FEED_NOT_FOUND = 1,
      ERR_FEED_OPEN = 2;

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

    this.streamOptions = Object.assign({
        timeout: 5000,
        maxListeners: 0
    }, streamOptions || {});
}

Archiver.prototype.id = function() {
    return this.drive.core.id;
}

Archiver.prototype.stat = function(discoveryKey, cb) {
    var core = this.drive.core;
    core._feeds.get(discoveryKey, (error, feed) => {
        if (error)
            cb(error);
        else if (feed)
            cb(ERR_NONE, feed);
        else
            cb(ERR_FEED_NOT_FOUND);
    });
}

Archiver.prototype.create = function(files, cb) {
    var archive = this.createArchive();
    Entries.archive(archive, files, cb);
}

Archiver.prototype.remove = function(discoveryKey, cb) {
    var self = this;
    var core = self.drive.core;

    self.stat(discoveryKey, (error, feed) => {
        if (error) return cb(error);

        core._feeds.del(discoveryKey, null, error => {
            cb(error, discoveryKey);
        });
    })
}

Archiver.prototype.open = function(discoveryKey, cb) {
    var self = this;
    self.stat(discoveryKey, (error, feed) => {
        const hasContent = !error && feed;
        var archive = self.createArchive(discoveryKey, hasContent, feed);
        archive.open(cb);
    });
}

Archiver.prototype.replicate = function(peer) {
    var self = this;
    var stream = this.drive.core.replicate();

    stream.setTimeout(this.streamOptions.timeout, stream.destroy);
    stream.setMaxListeners(this.streamOptions.maxListeners);

    stream.on('open', discoveryKeyBuffer => {
        var discoveryKey = discoveryKeyBuffer.toString('hex');

        self.stat(discoveryKey, (error, feedInfo) => {
            if (error) {
                logger.error('Upload error:', error);
                return stream.close();
            }

            var feed = self.createFeed(feedInfo);
            logger.debug("Uploading", feed.key
                         ? feed.key.toString('hex')
                         : 'discoveryKey ' + discoveryKey,
                         peer);
            feed.replicate({ stream: stream });
        })
    });

    return stream;
}

Archiver.prototype.createArchive = function(key, feedInfo) {
    var feed, hasContent = !!feedInfo;
    if (hasContent)
        feed = this.createFeed(feedInfo);

    var archive = this.drive.createArchive(key, { metadata: feed });
    archive.owner = hasContent;
    return archive;
}

Archiver.prototype.createFeed = function(feedInfo) {
    var feed = Feed(this.drive.core, Object.assign({}, {
        valueEncoding: this.drive.core._valueEncoding
    }, feedInfo));

    feed.prefix = feedInfo.prefix;
    return feed;
}

Archiver.prototype.copyArchive = function(archive, destination, cb) {
    Entries.copy(archive, destination, cb);
}


Entries.path = function(entry, destination) {
    const name = entry.hasOwnProperty('name') ? entry.name : entry;
    const joined = path.join.apply(path, name.split(path_re));
    const relative  = path.normalize(joined).replace(rel_re, '');
    return path.join(destination, relative);
}

Entries.is_file = function(entry) {
    return entry && entry.type == 'file' && entry.name;
}

Entries.map = function(entries, destination) {
    var paths = {};

    for (var entry of entries)
        try {
            if (Entries.is_file(entry))
                paths[entry.name] = Entries.path(entry, destination);
        } catch (e) {
            logger.error('Entry path mapping error:', e);
        }

    return paths;
}

Entries.list = function(entries, destination) {
    var paths = [];

    for (var entry of entries)
        try {
            if (Entries.is_file(entry)) {
                var entryPath = Entries.path(entry, destination);
                paths.push(entryPath);
            }
        } catch (e) {
            logger.error('Entry path mapping error:', e);
        }

    return paths;
}

Entries.listArchive = function(archive, destination, cb) {
    archive.list(null, (error, entries) => {
        if (error)
            eb(error);
        else
            cb(null, Entries.list(entries, destination));
    });
}

Entries.copy = function(archive, destination, cb) {
    archive.list(null, (error, entries) => {
        if (error) return cb(error);

        const paths = Entries.map(entries, destination);

        asyncEach(entries, (entry, next, left) => {
            if (!Entries.is_file(entry)) return next();

            const dest = paths[entry.name];

            try {
                mkdirp.sync(path.dirname(dest));
            } catch (error) {
                return cb(error);
            }

            var rs = archive.createFileReadStream(entry);
            var ws = fs.createWriteStream(dest);

            rs.on('error', err => logger.error('ReadStream error [copy]:', err));
            ws.on('error', err => logger.error('WriteStream error [copy]:', err));

            pump(rs, ws, error => {
                if (error)
                    cb(error);
                else if (!left)
                    cb(ERR_NONE, Object.keys(paths).map(k => paths[k]));
                else
                    next();
            });
        });
    });
}

Entries.archive = function(archive, files, cb) {
    asyncEach(files, (file, next, left) => {
        const source = file[0];
        const name = file[1];

        var rs = fs.createReadStream(source);
        var ws = archive.createFileWriteStream({ name: name });

        rs.on('error', err => logger.error('ReadStream error [archive]:', err));
        ws.on('error', err => logger.error('WriteStream error [archive]:', err));

        pump(rs, ws, error => {
            if (error)
                cb(error);
            else if (!left)
                cb(ERR_NONE, archive);
            else
                next();
        });
    });
}

function asyncEach(source, fn) {
    var items = source.slice();
    var next = error => {
        if (!error && items.length > 0)
            setTimeout(() => fn(items.shift(), next, items.length), 0);
    }; next();
}

module.exports = Archiver;
