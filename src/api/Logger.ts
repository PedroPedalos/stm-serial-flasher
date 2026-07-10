
class Logger {
    allLogger: Array<{ log: (...args: any[]) => void }>;

    constructor() {
        this.allLogger = [];
    }

    registerLogger(logger: { log: (...args: any[]) => void }) {
        this.allLogger.push(logger);
    }

    log(...args: any[]) {
        this.allLogger.forEach((logger) => {
            logger.log.apply(null, args);
        });
    }
}

const logger = new Logger();

export default logger;