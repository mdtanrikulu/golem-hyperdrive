const v8 = require('v8');
const logger = require('./logger').logger;

const DEFAULT_INTERVAL = 1800 * 1000;


function GCJob(interval) {
	this.job = null;
	this.interval = interval || DEFAULT_INTERVAL;
}

GCJob.prototype.start = function() {
	if (!global.gc) {
		logger.warn(`Global GC is not exposed; ` +
			        `collection job won't be started`);
		return;
	}

	if (this.job) {
		logger.warn('GC job already started');
		return;
	}

	logger.debug(`Starting GC job with interval of ` +
		         `${this.interval / 1000} s`);
	this.job = setInterval(_gc, this.interval);
}

GCJob.prototype.stop = function() {
	if (!this.job) {
		logger.warn('GC job not started');
		return;
	}

	logger.debug(`Stopping GC job`);
	clearInterval(this.job);
	this.job = null;
}

GCJob.prototype.isRunning = function() {
	return !!this.job;
}


function _gc() {
	global.gc();
	logger.debug('Post-GC heap statistics:');
	logger.debug(v8.getHeapStatistics());
}


module.exports = {
	GCJob: GCJob
};
