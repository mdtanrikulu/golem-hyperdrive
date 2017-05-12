const winston = require('winston');
const common = require('./common');

var twoDigits   = (input) => ('0'  + input).slice(-2);
var threeDigits = (input) => ('00' + input).slice(-3);

var timestamp = () => {
    var date = new Date();
    return  twoDigits(date.getHours())   + ':' + 
            twoDigits(date.getMinutes()) + ':' + 
            twoDigits(date.getSeconds()) + '.' + 
            threeDigits(date.getMilliseconds());
};

var formatter = options =>
    '[' + options.timestamp() + '] ' +
    '[' + common.application  + '] ' +
    '[' + options.level.toUpperCase() + '] ' + 
    (options.message || '') +
    (options.meta && Object.keys(options.meta).length 
        ? '\n\t'+ JSON.stringify(options.meta) 
        : '' );

var logger = new winston.Logger({
    level: 'debug',
    transports: [
        new winston.transports.Console({
            timestamp: timestamp,
            formatter: formatter
        })
    ]
});

module.exports = logger;