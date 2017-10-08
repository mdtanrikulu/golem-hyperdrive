const fs = require('fs');
const hash = require('hypercore/lib/hash');
const mkdirp = require('mkdirp');
const path = require('path');
const pump = require('pump');

const Feed = require('hypercore/lib/feed');
const Hyperdrive = require('hyperdrive');
const Level = require('level');

const common = require('./common');
const logger = require('./logger').logger;

/* Error codes */
const ERR_NONE = null,
      ERR_FEED_NOT_FOUND = 1,
      ERR_FEED_OPEN = 2;

/* Path regular expressions */
const rel_re = /^(\.\.[\/\\])+/;
const path_re = /\/|\\/;


function Archiver(options, streamOptions) {
    options.db = path.join(options.db, common.version);

    if (!fs.existsSync(options.db))
        mkdirp.sync(options.db);

    this.db = Level(options.db);
    this.drive = Hyperdrive(this.db);

    this.options = options;
    this.streamOptions = Object.assign({
        timeout: 5000,
        maxListeners: 0
    }, streamOptions || {});
}

Archiver.prototype.id = function() {
    return this.drive.core.id.toString('hex');
};

Archiver.prototype.stat = function(discoveryKey, cb) {
    var core = this.drive.core;
    core._feeds.get(discoveryKey, (error, feed) => {
        if (error)     cb(error);
        else if (feed) cb(ERR_NONE, feed);
        else           cb(ERR_FEED_NOT_FOUND);
    });
};

Archiver.prototype.create = function(files, cb) {
    var archive = this.drive.createArchive();
    Entries.archive(archive, files, cb);
};

Archiver.prototype.remove = function(discoveryKey, cb) {
    var core = this.drive.core;
    core._feeds.del(discoveryKey, error => {
        cb(error, discoveryKey);
    });
};

Archiver.prototype.replicate = function(peer) {
    var self = this;
    var stream = this.drive.core.replicate();

    stream.setTimeout(this.streamOptions.timeout, stream.destroy);
    stream.setMaxListeners(this.streamOptions.maxListeners);

    stream.on('open', discoveryBuffer => {
        var discoveryKey = discoveryBuffer.toString('hex');

        logger.debug('Archive requested', discoveryKey, peer);

        self.stat(discoveryKey, (error, feedInfo) => {
            if (error)
                return logger.debug('Upload error:', error);

            var feed = self.createFeed(feedInfo);
            logger.debug("Uploading", feed.key.toString('hex'));
            feed.replicate({ stream: stream });
        });
    });

    return stream;
};

Archiver.prototype.createFeed = function(feedInfo) {
    var feed = Feed(this.drive.core, Object.assign({}, {
        valueEncoding: this.drive.core._valueEncoding
    }, feedInfo));

    feed.prefix = feedInfo.prefix;
    return feed;
};

Archiver.prototype.copyArchive = function(archive, destination, cb) {
    Entries.save(archive, destination, cb);
};


function Entries() {}

Entries.is_file = function(entry) {
    return entry && entry.type == 'file' && entry.name;
};

Entries.path = function(entry, destination) {
    const name = entry.hasOwnProperty('name') ? entry.name : entry;
    const joined = path.join.apply(path, name.split(path_re));
    const relative  = path.normalize(joined).replace(rel_re, '');
    return path.join(destination, relative);
};

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
};

Entries.save = function(archive, destination, cb) {
    archive.list(null, (error, entries) => {
        if (error) return cb(error);

        const paths = Entries.map(entries, destination);
        const files = Object.keys(paths).map(k => paths[k]);

        asyncEach(entries, (entry, next, left) => {
            if (!Entries.is_file(entry)) return next();

            const dest = paths[entry.name];

            if (Entries.exists(archive, entry, dest))
                try {
                    fs.unlinkSync(dest);
                } catch(error) {
                    logger.error('Cannot remove', dest);
                }

            logger.debug('Saving', entry.name, '->', dest);

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
};

Entries.archive = function(archive, files, cb) {
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
};

Entries.exists = function(archive, entry, path) {
    return archive.isEntryDownloaded(entry) &&
           fs.existsSync(path);
};


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
