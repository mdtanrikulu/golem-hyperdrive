const http = require('http');
const assert = require('assert');
const common = require('./common');

const logger = require('./logger').logger;

const DEFAULT_HOST = 'localhost';
const DEFAULT_PORT = 3292;


function RPC(app, port, host) {
    this.port = port || DEFAULT_PORT;
    this.host = host || DEFAULT_HOST;
    this.app = app;
}

RPC.prototype.listen = function() {
    var self = this;

    self.server = http.createServer((request, response) =>
        self._route(self, request, response)
    );

    // FIXME: keepalive
    self.server.setTimeout(10 * 120 * 1000);

    self.server.on('error', error => {
        logger.error('Error listening on',
                     self.host + ':' + self.port,
                     ':', error.code);
        process.exit(1);
    });

    return new Promise((cb, err) => {
        self.server.once('listening', error => {
            if (error) err(error);
            else cb();
        });
        self.server.listen(self.port, self.host);
    });
};

RPC.prototype._route = function(ctx, request, response) {
    var self = ctx;
    var body = [], json;

    try {
        self._validateRequest(request);
    } catch (error) {
        return self._respond({
            error: error
        }, response, 400);
    }

    request.on('error', error => {

        self._respond({
            error: error.message
        }, response, 400);

    }).on('data', chunk => {

        body.push(chunk);

    }).on('end', () => {

        body = body.join('');

        try {
            json = JSON.parse(body);
        } catch(exc) {
            return self._respond({
                error: exc.message
            }, response, 400);
        }

        if (!self._commands.hasOwnProperty(json.command)) {
            return self._respond({
                error: 'Invalid command'
            }, response, 400);
        }

        logger.debug(request.connection.remoteAddress,
                     request.connection.remotePort,
                     '->', json);

        try {
            self._commands[json.command](self, json, response);
        } catch(exc) {
            logger.error(`Command error: ${json.command}:`,
                         exc);
            return self._respond({
                error: exc.message
            }, response, 400);
        }
    });
};

RPC.prototype._commands = {
    id: (self, json, response) => {
        self._respond({
            id: self.app.id(),
            version: common.version,
        }, response);
    },
    download: (self, json, response) => {

        function gt0(src) {
            let value = parseInt(src);
            if (value <= 0)
                throw new Error('Invalid value: ' + src);
            return value;
        }

        try {
            assert.ok(json.hash);
            assert.ok(json.dest);
            json.size = json.size ? gt0(json.size) : null;
            json.timeout = json.timeout ? gt0(json.timeout) * 1000 : null;
        } catch (exc) {
            logger.error("RPC error [download]", exc);
            return self._respond({
                error: exc.message
            }, response, 400);
        }

        self.app.download(json.hash, json.dest, json.peers,
                          json.size, json.timeout)
            .then(files => {
                self._respond({
                    files: files
                }, response);
            }, error => {
                self._respond({
                    error: error.message || error
                }, response, 400);
            });
    },
    upload: (self, json, response) => {

        if (!json.hash)
            try {
                assert.ok(json.files);
                json.files = Object.keys(json.files)
                    .map(key => {
                        return [key, json.files[key]];
                    });
            } catch (exc) {
                logger.error("RPC error [upload]", exc);
                return self._respond({
                    error: exc.message
                }, response, 400);
            }

        try {
            json.timeout = json.timeout ? gt0(json.timeout) * 1000 : null;
        } catch (exc) {
            logger.error("RPC error [upload]", exc);
            return self._respond({
                error: exc.message
            }, response, 400);
        }

        self.app.upload(json.files, json.hash, json.timeout)
            .then(hash => {
                self._respond({
                    hash: hash
                }, response);
            }, error => {
                self._respond({
                    error: error
                }, response, 400);
            });
    },
    cancel: (self, json, response) => {
        assert.ok(json.hash);

        self.app.cancel(json.hash)
            .then(hash => {
                self._respond({
                    hash: hash
                }, response);
            }, error => {
                self._respond({
                    error: error
                }, response, 404);
            });
    },
    addresses: (self, json, response) => {
        var addresses = self.app.addresses(self.app.swarm);
        self._respond({
            addresses: addresses
        }, response);
    }
};

RPC.prototype._validateRequest = function(request) {
    if (request.method.toLowerCase() != 'post')
        throw new Error('Invalid request method');
    if (request.headers['content-type'] != 'application/json')
        throw new Error('Invalid content type');
};

RPC.prototype._respond = function(data, response, code) {
    var response_data = data
        ? JSON.stringify(data)
        : '';

    logger.debug(response.connection.remoteAddress,
                 response.connection.remotePort,
                 '<-', data);

    response.statusCode = code || 200;
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Content-Length', Buffer.byteLength(response_data));
    response.write(response_data);
    response.end();
};

module.exports = RPC;
