export interface IRCMOptions {
    storagePath: string;
    debug?: boolean;
    readFromDiskAlways?: boolean;
    ipUsageLimit?: number;
    _currentIpUse?: number;
}
export interface IRCMOptions_source {
    source: string;
    diskTimeToLive?: number;
    requestHeaders?: (source: IRCMOptions_source) => any;
    pageResponse: (body: string, url: string, ipAddress: string) => string | Date;
}
export interface IIpObj {
    date?: Date;
    ipAddress: string;
}
export interface IPageCacheObj {
    date?: Date;
    url?: string;
    page: string;
}
export declare class RequestConsistencyMiner {
    private options;
    private torClientOptions;
    private allUsedIpAddresses;
    private obsExpiringIpAddresses;
    private ipStorageLocation;
    private torReady;
    private tcc;
    private tr;
    private pageCache;
    private obsExpiringPageCache;
    constructor(options: IRCMOptions, torClientOptions: any);
    torRequest(oSource: IRCMOptions_source): string;
    static MAX_NEW_SESSIONS: number;
    private _torRequest(oSource);
    private whenIpOverUsed(oSource);
    private gettingNewSession;
    torNewSession(): Promise<any>;
    private newIpUntilUnused();
    private ifIpAlreadyUsed(ipAddress);
    private watchListStart($list, removeList);
    getIpBlackList(): string[];
    getIpBackoffList(): string[];
    private readIpList();
    private writeIpList(ipAddress, date?);
    private readList(path);
    private writeList(path, list);
    private _readUrlFromDisk(url);
    private urlToDir(url);
    private testIfDateExpired(obj, dir);
    private _writeUrlToDisk(url, data);
    private addPageToPageCache(obj);
    private deleteFile(path);
}
