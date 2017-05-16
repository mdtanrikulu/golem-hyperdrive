#!/usr/bin/env node

const abi = require('node-abi');
const archiver = require('archiver');
const spawn = require('child_process').spawn;
const fs = require('fs');
const mkdirp = require('mkdirp');
const os = require('os');
const rimraf = require('rimraf');
const package = require('./package.json');

const ABI = abi.getAbi();
const APP = package.alias.toLowerCase();

const DIST_DIR = 'dist';
const OUT_DIR = `${DIST_DIR}/${APP}`;

/* Helper functions */

const getPlatform = () => {
    var type = os.type().toLowerCase();
    return type.indexOf('windows') == -1
        ? type : 'win32';
}

const copyFile = (src, dest) => {
    var rs = fs.createReadStream(src);
    var ws = fs.createWriteStream(dest)
    rs.pipe(ws);
}

const copyModule = (name, module, abi) => {
    var built = `node_modules/${name}/build/Release/${module}.node`;
    var abi = abi || ABI;

    if (fs.existsSync(built))
        copyFile(built, `${OUT_DIR}/${module}.node`);
    else
        copyFile(`node_modules/${name}/prebuilds/` +
                 `${getPlatform()}-x64/node-${abi}.node`,
                 `${OUT_DIR}/${module}.node`);
}

const replaceInFile = (file, search, replace) => {
    var contents = fs.readFileSync(file, 'utf8');
    contents = contents.replace(search, replace);
    fs.writeFileSync(file, contents, 'utf8');
}

/* Dependencies */

function Dependencies() {
    mkdirp.sync(OUT_DIR);
    for (var i in Dependencies)
        Dependencies.hasOwnProperty(i) && Dependencies[i]();
}

Dependencies.rabin = () =>
    copyModule('rabin', 'rabin');

Dependencies.leveldown = () =>
    copyModule('leveldown', 'leveldown');

Dependencies.sodium = () =>
    copyModule('sodium-native', 'sodium', 51);

Dependencies.utp = () =>
    copyModule('utp-native', 'utp');


function Patch() {
    var keys = [];
    for (var i in Patch)
        Patch.hasOwnProperty(i) && keys.push(i);

    keys.forEach(k => Patch[k].patch());
    return () =>
        keys.forEach(k => Patch[k].revert());
}

Patch.utp = {
    patch: () => replaceInFile(
        Patch.utp.file,
        Patch.utp.search,
        Patch.utp.replace
    ),
    revert: () => replaceInFile(
        Patch.utp.file,
        Patch.utp.replace,
        Patch.utp.search
    ),

    file: "node_modules/utp-native/index.js",
    search: "var utp = require('node-gyp-build')(__dirname)",
    replace: "var utp = require('./build/Release/utp')"
}

/* Build */

function Build() {
    Dependencies();

    const revert = Patch();
    const error = err => {
        console.error(`Error building executable: ${err}`);
        revert();
    }

    Build.main().then(
        () => Build.client().then(revert, error),
        error
    );
}

Build.main = () =>
    Build.build('src/index.js', `${OUT_DIR}/hyperg`)

Build.client = () =>
    Build.build('src/client.js', `${OUT_DIR}/hyperg-client`)

Build.build = (source, output) => {
    var platform = getPlatform();
    if (platform == 'win32')
        output += '.exe';

    var args = ['node_modules/pkg/lib-es5/bin.js',
                '-c', 'package.json', '-o', output, source];

    console.log(`> Building executable for ${source}`)
    console.log(`> ${args.join(' ')}`)

    return new Promise((cb, eb) =>
        spawn('node', args)
            .on('close', code => {
                if (code == 0) cb();
                else eb(`"pkg" exited with code ${code}`);
            })
    );
}

const clean = () => rimraf.sync(DIST_DIR);

/* Archive */

const archive = () => {
    var platform = getPlatform();
    var format = 'tar';
    var ext = 'tar.gz';

    if (platform == 'win32') {
        platform = 'windows';
        ext = format = 'zip';
    }

    var name = `${APP}_${package.version}_${platform}-x64.${ext}`;
    var output = fs.createWriteStream(`${DIST_DIR}/${name}`);
    var archive = archiver(format);

    output.on('error', console.error);
    output.on('close', () =>
        console.log(`Archive saved: ${name} (${archive.pointer()} bytes)`)
    );

    archive.pipe(output);
    archive.directory(OUT_DIR, APP);
    archive.finalize();
}

/* Exports */

var exports = {
    archive: archive,
    build: Build,
    clean: clean,
    deps: Dependencies
}

module.exports = exports;

/* Run commands */

if (process.argv.length > 2) {
    var commands = process.argv.slice(2);
    for (var command of commands)
        exports[command]();
}
