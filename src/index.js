#!/usr/bin/env node

const assert = require('assert');
const minimist = require('minimist');
const winston = require('winston');

const common = require('./common');
const Server = require('./hyperg');


const logger_module = require('./logger');
const logger = logger_module.logger;

var options = minimist(
    process.argv.slice(2)
);

function usage() {
    let s = "\t\t\t\t";
    console.log(common.application + " usage:", "\n");
    console.log("  --db [path]");
    console.log(s, "Database path");
    console.log("  --host [ip]");
    console.log(s, "IP address to listen on");
    console.log("  --port [int]");
    console.log(s, "TCP port to listen on");
    console.log("  --rpc_host [ip]");
    console.log(s, "IP address for RPC to listen on");
    console.log("  --rpc_port [int]");
    console.log(s, "TCP port for RPC to listen on");
    console.log("  --sweep_interval [int]");
    console.log(s, "Database sweep interval in seconds");
    console.log("  --sweep_lifetime [int]");
    console.log(s, "Database lifetime of shares in seconds");
    console.log("  --logfile [path]");
    console.log(s, "Log to file");
    console.log("  --loglevel [error|warn|info|verbose|debug]");
    console.log(s, "Set the default logging level");
    console.log("  -v --version");
    console.log(s, "Display version information");
    console.log("  -h --help");
    console.log(s, "Display this help message", "\n");
}

if (options.v || options.version)
    return console.log(common.version);
if (options.h || options.help)
    return usage();

if (options.sweep_lifetime) {
    let lifetime = parseInt(options.sweep_lifetime);
    options.sweep_lifetime = Math.max(lifetime, 0) * 1000;
}

if (options.logfile)
    logger_module.addFileTransport(options.logfile);
if (options.loglevel)
    logger_module.setLevel(options.loglevel);

var server = new Server(options);
server.run();
