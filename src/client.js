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
    var input_files = [options.u || options.upload];
    var files = {};

    if (options._.length > 0)
        input_files = input_files.concat(options._);

    for (var file of input_files)
        files[file] = path.basename(file);

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
    let s = "\t\t\t\t";
    console.log(common.application + " usage:", "\n");
    console.log("  -d --download [hash] [dst_dir]");
    console.log(s, "Download an archive with [hash] to [dst_dir]");
    console.log("  -u --upload [file_1] [file_2] ...");
    console.log(s, "Create and share an archive with given files");
    console.log("  -c --cancel [hash]");
    console.log(s, "Stop sharing an archive identified by [hash]");
    console.log("  -a --addresses");
    console.log(s, "Display listening addresses");
    console.log("  -v --version");
    console.log(s, "Display version information");
    console.log("  --host");
    console.log(s, "RPC IP address");
    console.log("  --port");
    console.log(s, "RPC port", "\n");
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
