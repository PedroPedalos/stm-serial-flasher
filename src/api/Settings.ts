const REPLY_MODE = 'reply_mode';
const BAUDRATE = 'baudrate';
const START_ADDRESS = 'start_address';

class Settings {
    _replyMode: boolean;
    _baudrate: string;
    _startAddress: string;

    constructor() {
        this._replyMode = localStorage.getItem(REPLY_MODE) === "true" || false;
        this._baudrate = localStorage.getItem(BAUDRATE) || "9600";
        this._startAddress = localStorage.getItem(START_ADDRESS) || "0x8000000";
    }

    set replyMode(reply: boolean) {
        this._replyMode = reply;
        this.commit();
    }

    get replyMode(): boolean {
        return this._replyMode;
    }

    set baudrate(baudrate: string) {
        this._baudrate = baudrate;
        this.commit();
    }

    get baudrate(): string {
        return this._baudrate;
    }

    get startAddress(): string {
        return this._startAddress;
    }

    set startAddress(address: string) {
        this._startAddress = address;
        this.commit();
    }

    commit() {
        localStorage.setItem(REPLY_MODE, String(this._replyMode));
        localStorage.setItem(BAUDRATE, this._baudrate);
        localStorage.setItem(START_ADDRESS, this._startAddress);
    }
}

const settings = new Settings();

export default settings;