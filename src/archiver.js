const fs = require('fs');
const mkdirp = require('mkdirp');
const path = require('path');
const pump = require('pump');

function Archiver() {}

Archiver.add = (archive, entries, callback) => {
    var left = entries.length;
    asyncEach(entries, entry => {
        const source = entry[0], name = entry[1];
        var rs = fs.createReadStream(source);
        var ws = archive.createFileWriteStream({ name: name });

        rs.on('error', rs_error => {
            console.error('HyperG: add ReadStream error:', rs_error);
        });
        ws.on('error', ws_error => {
            console.error('HyperG: add WriteStream error:', rs_error);
        });

        pump(rs, ws, error => {
            callback(source, error, --left);
        });
    });
}

Archiver.get = (archive, destination, callback) => {
    var download = (error, entries) => {
        var left = entries.length;
        if (error) return callback(undefined, error, left);

        asyncEach(entries, entry => {
            const dst = path.join(destination, entry.name);

            // if (archive.isEntryDownloaded(entry)) {
            //     console.log("Already downloaded", entry);
            //     return callback(dst, undefined, --left);
            // }

            mkdirp(path.dirname(dst), error => {
                if (error) return callback(dst, error, left);
                var rs = archive.createFileReadStream(entry);
                var ws = fs.createWriteStream(dst);

                rs.on('error', rs_error => {
                    console.error('HyperG: get ReadStream error:', rs_error);
                });
                ws.on('error', ws_error => {
                    console.error('HyperG: get WriteStream error:', rs_error);
                });

                pump(rs, ws, error => {
                    callback(dst, error, --left);
                });
            });
        });
    };

    archive.list({}, download);
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
