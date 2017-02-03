#!/usr/bin/env node

const assert = require('assert');
const minimist = require('minimist');
const HyperG = require('./hyperg');

var options = minimist(process.argv.slice(2));

if (!!options.port)
    options.port = parseInt(options.port);
if (!!options.id)
    assert.ok(options.id.length == 32)

var hyperg = new HyperG(options);
hyperg.run();
