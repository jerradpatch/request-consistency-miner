export interface IRCMOptions {
    storagePath: string;
    debug?: boolean;
    readFromDiskAlways?: boolean;
    ipUsageLimit?: number;
    _currentIpUse?: number;
    sources: {
        [source: string]: IRCMOptions_source;
    };
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
    date: Date;
    page: string;
}
export declare class RequestConsistencyMiner {
    private options;
    private torClientOptions;
    private allUsedIpAddresses;
    private obsExpiringIpAddresses;
    private subWatchList;
    private ipStorageLocation;
    private torReady;
    private tcc;
    private tr;
    private pageCache;
    constructor(options: IRCMOptions, torClientOptions: any);
    torRequest(url: any, recur?: number): string;
    private _torRequest(url, recur?);
    private getSource(url);
    private whenIpOverUsed(oSource);
    private gettingNewSession;
    private torNewSession();
    private newIpUntilUnused();
    private ifIpAlreadyUsed(ipAddress);
    private randomUserHeaders(oSource);
    private watchListStart($list);
    getIpBlackList(): string[];
    getIpBackoffList(): string[];
    private readIpList();
    private writeIpList(ipAddress, date?);
    private readList(path);
    private writeList(path, list);
    private _readUrlFromDisk(url);
    private _writeUrlToDisk(url, data);
}
