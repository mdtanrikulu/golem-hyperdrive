const winston = require('winston');
const common = require('./common');

var twoDigits   = (input) => ('0'  + input).slice(-2);
var threeDigits = (input) => ('00' + input).slice(-3);

var timestamp = () => {
    var date = new Date();
    // 2017-06-07 15:52:55.123
    return date.getFullYear() + '-' +
           twoDigits(date.getMonth()) + '-' +
           twoDigits(date.getDate()) + ' ' +
           twoDigits(date.getHours())   + ':' +
           twoDigits(date.getMinutes()) + ':' +
           twoDigits(date.getSeconds()) + '.' +
           threeDigits(date.getMilliseconds());
};

var formatter = options =>
    options.timestamp() + ' ' +
    '[' + common.application  + '] ' +
    '[' + options.level.toUpperCase() + '] ' +
    (options.message || '') +
    (options.meta && Object.keys(options.meta).length
        ? '\n\t'+ JSON.stringify(options.meta)
        : '' );

var logger = new winston.Logger({
    level: 'info',
    transports: [
        new winston.transports.Console({
            timestamp: timestamp,
            formatter: formatter
        })
    ]
});

function setLevel(level) {
    for (let transportName in logger.transports)
        logger.transports[transportName].level = level;
}

module.exports = {
    'logger': logger,
    'setLevel': setLevel,
    'timestamp': timestamp,
    'formatter': formatter
};
