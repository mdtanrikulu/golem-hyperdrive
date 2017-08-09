#!/usr/bin/env node

const assert = require('assert');
const minimist = require('minimist');

const common = require('./common');
const Server = require('./hyperg');

const heapdump = require('heapdump');  

heapdump.writeSnapshot(function(err, filename) {  
  console.log('dump written to', filename);
});

var options = minimist(
    process.argv.slice(2),
    { 'string': ['logfile'] }
);

if (options.v || options.version)
    return console.log(common.version);

if (options.h) {
    options.host = options.h;
    delete options.h;
}
if (options.p) {
    options.port = options.p;
    delete options.p;
}

var server = new Server(options);
server.run();
