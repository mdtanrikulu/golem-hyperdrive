const package = require('../package.json');

module.exports = {
    application: package.shortName,
    version: package.version,
    features: package.features
}
