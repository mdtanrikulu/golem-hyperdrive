#!/usr/bin/env node

const http = require('http');
const minimist = require('minimist');
const path = require('path');

function usage(code) {
    console.log("HyperG usage:");
    console.log("\t1) --download [hash] [to_dir]");
    console.log("\t2) --upload [file_1] [file_2] ...");
    console.log("\nadditional options:");
    console.log("\t --host  daemon IP address");
    console.log("\t --port  daemon port");
    process.exit(code);
}

function request(json, options) {
    var post_data = JSON.stringify(json);
    var post_options = {
        agent: new http.Agent({ keepAlive: true }),
        host: options.host || '127.0.0.1',
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

var options = minimist(process.argv.slice(2));
var json;

if (options.download && options._.length >= 1)
    request({
        command: 'download',
        hash: options.download,
        dest: options._[0]
    }, options);

else if (options.upload) {
    var input_files = [options.upload];
    var files = {};

    if (options._)
        input_files.concat(options._);

    for (var idx in input_files) {
        var file = input_files[idx];
        files[file] = path.basename(file);
    }

    request({
        command: 'upload',
        files: files
    }, options);
} else
    usage(1);
