#!/usr/bin/env node

const http = require('http');
const minimist = require('minimist');
const path = require('path');

const common = require('./common');

var options = minimist(process.argv.slice(2));
var hasArgs = options._.length >= 1;

if ((options.d || options.download) && hasArgs)
    download(options);
else if (options.u || options.upload)
    upload(options);
else if (options.c || options.cancel)
    cancel(options);
else if (options.a || options.addresses)
    addresses(options);
else if (options.v || options.version)
    version();
else
    usage(1);

function download(options) {
    request({
        command: 'download',
        hash: options.d || options.download,
        dest: options._[0]
    }, options);
}

function upload(options) {
    console.log("options", options);
    var input_files = [options.u || options.upload];
    var files = {};

    if (options._.length > 0)
        input_files = input_files.concat(options._);
    console.log("input_files", input_files);

    for (var file of input_files)
        files[file] = path.basename(file)

    request({
        command: 'upload',
        files: files
    }, options);
}

function cancel(options) {
    request({
        command: 'cancel',
        hash: options.c || options.cancel
    }, options);
}

function addresses(options) {
    request({
        command: 'addresses'
    }, options);
}

function version() {
    console.log(common.version);
}

function usage(code) {
    console.log(common.application + " usage:");
    console.log("\t1) -d --download [hash] [dst_dir]");
    console.log("       Download an archive with [hash] to [dst_dir]");
    console.log("\t2) -u --upload [file_1] [file_2] ...");
    console.log("       Create and share an archive with given files");
    console.log("\t3) -c --cancel [hash]");
    console.log("       Stop sharing an archive identified by [hash]");
    console.log("\t4) -a --addresses");
    console.log("       Display listening addresses");
    console.log("\t5) -v --version");
    console.log("       Display version information");
    console.log("\nadditional options:");
    console.log("\t --host  daemon IP address");
    console.log("\t --port  daemon port");
    process.exit(code);
}

function request(json, options) {
    var post_data = JSON.stringify(json);
    var post_options = {
        agent: new http.Agent({ keepAlive: true }),
        host: options.host || 'localhost',
        port: options.port || 3292,
        path: '/',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(post_data)
        }
    };

    var body = [];
    var request = http.request(post_options, function(response) {
        response.setEncoding('utf8');

        response.on('data', chunk => {
            body.push(chunk);
        }).on('end', () => {
            console.log(body.join(''));
        }).on('error', error => {
            console.error('HyperG: response error:', error);
        });
    });

    request.on('error', error => {
        console.error('HyperG: request error:', error);
    });

    request.setSocketKeepAlive(true);
    request.write(post_data);
    request.end();
}
