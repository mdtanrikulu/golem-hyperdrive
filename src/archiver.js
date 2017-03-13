const fs = require('fs');
const mkdirp = require('mkdirp');
const path = require('path');
const pump = require('pump');

const rel_re = /^(\.\.[\/\\])+/;
const path_re = /\/|\\/;


function Archiver() {}

Archiver.add = (archive, entries, callback) => {
    var left = entries.length;
    asyncEach(entries, entry => {
        const source = entry[0], name = entry[1];
        var rs = fs.createReadStream(source);
        var ws = archive.createFileWriteStream({ name: name });

        rs.on('error', err => {
            console.error('HyperG: add ReadStream error:', err);
        });
        ws.on('error', err => {
            console.error('HyperG: add WriteStream error:', err);
        });

        pump(rs, ws, error => {
            callback(source, error, --left);
        });
    });
}

Archiver.get = (archive, destination, callback) => {
    archive.list(null, (error, entries) => {
        if (error) return callback(error);
        const paths = Archiver._entry_paths(destination, entries);
        const files = Object.keys(paths).map(k => paths[k]);

        asyncEach(entries, entry => {
            const dst = paths[entry.name];
            try {
                mkdirp.sync(path.dirname(dst));
            } catch (e) {
                return callback(e);
            }

            if (Archiver._entry_downloaded(archive, entry, dst))
                return;

            var rs = archive.createFileReadStream(entry);
            var ws = fs.createWriteStream(dst);

            pump(rs, ws, err => {
                if (err || Archiver._entries_downloaded(entries))
                    process.nextTick(() => {
                        callback(err, files);
                    });
            });
        });
    });
}

Archiver._entry_path = (destination, entry) => {
    const name = path.join.apply(path, entry.name.split(path_re));
    const rel  = path.normalize(name).replace(rel_re, '');
    return path.join(destination, rel);
}

Archiver._entry_paths = (destination, entries) => {
    var res = {};
    for (var i in entries) {
        var entry = entries[i];
        res[entry.name] = Archiver._entry_path(destination, entry);
    }
    return res;
}

Archiver._entry_downloaded = (archive, entry, dst) => {
    return archive.isEntryDownloaded(entry) && fs.existsSync(dst);
}

Archiver._entries_downloaded = (archive, entries, paths) => {
    for (var i in entries) {
        var entry = entries[i];
        if (!Archiver._entry_downloaded(archive, entry,
                                        paths[entry.name]))
            return false;
    }
    return true;
}

function asyncEach(items, fn) {
    var loop = () => {
        if (items.length > 0)
            setTimeout(() => {
                fn(items.shift()); loop();
            }, 0);
    }; loop();
}

module.exports = Archiver;
