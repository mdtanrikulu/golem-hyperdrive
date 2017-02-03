const fs = require('fs');
const mkdirp = require('mkdirp');
const path = require('path');
const pump = require('pump');

function Archiver() {}

Archiver.add = (archive, entries, callback) => {
    var left = entries.length;
    asyncEach(entries, entry => {
        const source = entry[0], name = entry[1];
        const rs = fs.createReadStream(source);
        const ws = archive.createFileWriteStream({ name: name });
        pump(rs, ws, error => {
            callback(source, error, --left);
        });
    });
}

Archiver.get = (archive, destination, callback) => {
    var download = (error, entries) => {
        if (error) return callback(undefined, error);

        var left = entries.length;
        asyncEach(entries, entry => {
            const dst = path.join(destination, entry.name);

            mkdirp(path.dirname(dst), error => {
                if (error) return callback(dst, error, left);
                const rs = archive.createFileReadStream(entry);
                const ws = fs.createWriteStream(dst);
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
