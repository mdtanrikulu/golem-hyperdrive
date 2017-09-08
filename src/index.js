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
    console.log("  --host [ip]");
    console.log(s, "IP address to listen on");
    console.log("  --port [int]");
    console.log(s, "TCP port to listen on");
    console.log("  --rpc_host [ip]");
    console.log(s, "IP address for RPC to listen on");
    console.log("  --rpc_port [int]");
    console.log(s, "TCP port for RPC to listen on");
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

if (options.logfile) {
    logger.info('Opening HyperG log file:', options.logfile);
    logger.add(
        winston.transports.File,
        {
            filename: options.logfile,
            json: false,
            timestamp: logger_module.timestamp,
            formatter: logger_module.formatter
        }
    );
}
if (options.loglevel)
    logger_module.setLevel(options.loglevel);

var server = new Server(options);
server.run();
