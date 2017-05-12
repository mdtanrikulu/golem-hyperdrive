#!/usr/bin/env node

const assert = require('assert');
const minimist = require('minimist');

const common = require('./common');
const Server = require('./hyperg');

var options = minimist(process.argv.slice(2));

if (options.v || options.version)
    return console.log(common.version);
if (options.p || options.port)
    options.port = parseInt(options.port);
if (options.i || options.id)
    assert.ok(options.id.length == 32)

var server = new Server(options);
server.run();
