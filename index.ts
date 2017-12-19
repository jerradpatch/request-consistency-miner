import {TorClientControl, TorRequest} from "tor-request";
import * as Future from 'fibers/future';
import * as Fiber from 'fibers/fibers';
import * as fs from 'fs';

import {Subject, Observable} from 'rxjs/Rx';

export interface IRCMOptions {
    storagePath: string,
    debug?: boolean,
    readFromDiskAlways?: boolean,
    ipUsageLimit?: number,
    _currentIpUse?: number;
};

export interface IRCMOptions_source {
    source: string;
    diskTimeToLive?: number,
    requestHeaders?: (source: IRCMOptions_source) => any,
    pageResponse: (body: string, url: string, ipAddress: string) => string|Date
}

export interface IIpObj {
    date?: Date;
    ipAddress: string;
};

export interface IPageCacheObj {
    date?: Date;
    url?: string;
    page: string;
};


const MAX_NEW_SESSIONS = 100;

export class RequestConsistencyMiner {


    private allUsedIpAddresses: IIpObj[] = [];
    private obsExpiringIpAddresses = new Subject<IIpObj>();

    private ipStorageLocation: string;

    private torReady: Promise<any>;

    private tcc : TorClientControl;
    private tr : TorRequest;

    private pageCache: {[key:string]: IPageCacheObj} = {};
    private obsExpiringPageCache = new Subject<IPageCacheObj>();

    constructor(private options: IRCMOptions, private torClientOptions) {

        if(!options.storagePath)
            throw new Error(`RCM:constructor:error no storagePath defined, storagePath: ${options.storagePath}`);


        this.ipStorageLocation = options.storagePath + 'ipStorage';
        this.allUsedIpAddresses =  this.readIpList();

        if(options.debug)
            console.log(`RCM:constructor, startup ip list read from the disk, ${JSON.stringify(this.allUsedIpAddresses)}`);

        this.tcc = new TorClientControl(torClientOptions);
        this.tr = new TorRequest();

        this.watchListStart(this.obsExpiringIpAddresses, (obj: IIpObj) => {
            let i = 0;
            while(i !== this.allUsedIpAddresses.length) {
                if(this.allUsedIpAddresses[i].ipAddress === obj.ipAddress) {
                    this.allUsedIpAddresses.splice(i, 1);
                } else {
                    i++;
                }
            }
        });

        this.watchListStart(this.obsExpiringPageCache, (obj: IPageCacheObj) => {
            delete this.pageCache[obj.url];
            this.deleteFile(obj.url);
        });

        this.torNewSession();
    }


    public torRequest(oSource: IRCMOptions_source): string {

        if(!oSource || !oSource.source || !oSource.pageResponse)
            throw new Error(`RCM:torRequest:error, the required properties of the 'IRCMOptions_source' were not set, oSource:${JSON.stringify(oSource)}`);

        let url = oSource.source;

        if(this.options.readFromDiskAlways || oSource.diskTimeToLive) { //get from disk

            let fut = new Future();
            this._readUrlFromDisk(url)
                .then((data: IPageCacheObj)=> {
                    if(this.options.debug)
                        console.log(`RCM:torRequest: file read from disk, keys: ${Object.keys(data)}`);

                    fut.return(data.page);
                })
                .catch((e)=> {
                    if(this.options.debug)
                        console.log(`RCM:torRequest: file not read from disk, err: ${e}`);

                    Fiber(() => {
                        let data =  this._torRequest(oSource);
                        let obj = {page:data};

                        if(oSource.diskTimeToLive) {
                            obj['date']  = new Date(Date.now() + oSource.diskTimeToLive);
                        }

                        return this._writeUrlToDisk(url, obj)
                            .then(() => {
                                fut.return(data);
                            }, (err) => {
                                if(this.options.debug)
                                    console.log(`RCM:torRequest:error, _writeUrlToDisk->err:${err}`);
                                fut.return(data);
                            });//always return data
                    }).run();
                });
            return fut.wait();
        } else { //get from web
            return this._torRequest(oSource);
        }
    }

    static MAX_NEW_SESSIONS = 100;

    private _torRequest(oSource: IRCMOptions_source): string {

        let url = oSource.source;

        let fut = new Future();

        if (this.options.debug)
            console.log(`RCM:_torRequest: request started, url: ${url}`);

        let newSessionCount = 0;

        let options = {
            timeout: 60000
        };

        fixHeaders(oSource, options);

        this.whenIpOverUsed(oSource).then((initialIpAddress)=> {
            let ipAddress = initialIpAddress;

            function processNewSession() {
                this.torNewSession().then((newIpAddress) => {
                    if (this.options.debug)
                        console.log(`RCM:_torRequest:torNewSession: recieved new session 1`);

                    ipAddress = newIpAddress;
                    processRequest.call(this);
                }, (err)=> {
                    if (this.options.debug)
                        console.error(`RCM:_torRequest:processNewSession:error: new Session threw an error 1: err: ${err}`);
                });
                newSessionCount++;
            };

            function processRequest() {

                this.tr.get(url, options, (err, res, body) => {

                    if(newSessionCount > MAX_NEW_SESSIONS){
                        if (this.options.debug)
                            console.error(`RCM:_torRequest:processRequest:error: the maximum attempt to get a new session was reached`);

                        throw new Error(`RCM:_torRequest:processRequest:error: the maximum attempt to get a new session was reached, MAX_NEW_SESSIONS:${MAX_NEW_SESSIONS}`);
                    }

                    if (!err && res.statusCode == 200) {
                        let pageSuccess = oSource.pageResponse(body, url, ipAddress);

                        switch (pageSuccess) {
                            case 'true':
                                this.options._currentIpUse++;

                                if (this.options.debug)
                                    console.log(`RCM:_torRequest:processRequest page returned, currentIpUse:${ipAddress}, source:${oSource.source}`);

                                fut.return(body);
                                break;
                            case 'blacklist':
                                this.writeIpList(ipAddress);

                                if (this.options.debug)
                                    console.error(`RCM:_torRequest:processRequest Ip added to the black list, blackList:${this.getIpBlackList()}`);

                                processNewSession.call(this);
                                break;
                            default:
                                if(pageSuccess instanceof Date) {
                                    this.writeIpList(ipAddress, pageSuccess);

                                    if (this.options.debug)
                                        console.error(`RCM:_torRequest:processRequest Ip added to the back off list, back-off list:${this.getIpBackoffList()}`);

                                    processNewSession.call(this);
                                } else {
                                    throw new Error(`RCM:_torRequest:processRequest, an invalid option was returned from pageResponse()`);
                                }
                        }

                    } else if (err && err.code == 'ETIMEDOUT') {
                        if (this.options.debug)
                            console.error(`RCM:_torRequest:processRequest:error: connection timed out`);

                    } else {
                        if (this.options.debug)
                            console.warn(`RCM:_torRequest:processRequest:error: ${err}, res.statusCode : ${res && res.statusCode}, \n\r oSource: ${JSON.stringify(oSource)}, \n\r options:${JSON.stringify(options)}`);

                        processNewSession.call(this);
                    }

                });
            };

            processRequest.call(this);
        });

        function fixHeaders(sour, ops){
            if (sour.requestHeaders) {
                let headers = sour.requestHeaders(sour);
                let host = headers['Host'] || headers['host'];
                if (host) {
                    if (host.indexOf('http://') === 0) {
                        host = host.slice('http://'.length)
                    } else if (host.indexOf('https://') === 0) {
                        host = host.slice('https://'.length);
                    }

                    let endOfDomain = host.indexOf('/');
                    if(endOfDomain > 0)
                        host = host.slice(0,endOfDomain);

                    headers['Host'] = host;
                    delete headers['host'];
                }

                ops['headers'] = headers;
            }
        }

        let page = fut.wait();
        return page;
    }

    // private getSource(url: string): IRCMOptions_source {
    //     if(url) {
    //         let start = url.indexOf('//') + 2;
    //         if(start < 0)
    //             throw new Error(`RCM:common:getSource:error url did not contain a protocol, url: ${url}`);
    //
    //         let end = url.indexOf('/', start);
    //         if(end < 0)
    //             end = url.length;
    //
    //         let sourceString = url.slice(start, end);
    //         return this.options.sources[sourceString];
    //     }
    //     throw new Error(`RCM:common:getSource:error url is not in the correct format, or no url was given, url: ${url}`)
    // }

    private whenIpOverUsed(oSource: IRCMOptions_source): Promise<any> {
        let ops = this.options;

        if(ops.ipUsageLimit && ops.ipUsageLimit <= ops._currentIpUse) {
            if(ops.debug)
                console.log(`RCM:whenIpOverUsed: count limit reached, source: ${oSource.source}`);

            return this.torNewSession();
        } else {
            ops._currentIpUse = ops._currentIpUse + 1 || 0;

            if(ops.debug)
                console.log(`RCM:whenIpOverUsed: current ipUsed#, source: ${oSource.source}, _currentIpUse #: ${ops._currentIpUse}`);

            return this.torReady;
        }
    }

    private gettingNewSession: boolean = false;
    public torNewSession(): Promise<any> {

        if(!this.gettingNewSession) {
            this.gettingNewSession = true;
            this.torReady = this.newIpUntilUnused()
                .then((ipAddress)=>{
                    this.options._currentIpUse = 0;
                    this.gettingNewSession = false;

                    this.tr;

                    return ipAddress;
                });
        }
        return this.torReady;
    }

    private newIpUntilUnused(): Promise<any> {

        return this.tcc.newTorSession().toPromise().then(function(ipAddress){

            if(!ipAddress) {
                return ipAddress;
            } else {
                let isUsed = this.ifIpAlreadyUsed(ipAddress);
                if(isUsed) {
                    return this.newIpUntilUnused();
                } else {
                    return ipAddress;
                }
            }
        }.bind(this) , function(err) {
            return this.newIpUntilUnused();
        }.bind(this));
    }

    private ifIpAlreadyUsed(ipAddress: string): boolean {
        let hasIp = this.allUsedIpAddresses.filter((used: IIpObj)=>{
                return used.ipAddress === ipAddress;
            }).length > 0;

        if(hasIp) {
            return true;
        } else {
            return false;
        }
    }


    //USER PROVIDED FUNCTIONALITY///////////////////
    // private randomUserHeaders(oSource: IRCMOptions_source) {
    //     let headers;
    //
    //     if(oSource.requestHeaders) {
    //         headers = oSource.requestHeaders(oSource);
    //     } else {
    //         let userAgent = [
    //             'Mozilla/5.0 (iPhone; CPU iPhone OS 9_1 like Mac OS X) AppleWebKit/601.1 (KHTML, like Gecko) CriOS/61.0.3163.100 Mobile/13B143 Safari/601.1.46',
    //             'Mozilla/5.0 (iPad; CPU OS 9_1 like Mac OS X) AppleWebKit/601.1 (KHTML, like Gecko) CriOS/61.0.3163.100 Mobile/13B143 Safari/601.1.46',
    //             'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/61.0.3163.100 Safari/537.36',
    //             'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/61.0.3163.100 Safari/537.36',
    //             'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/61.0.3163.100 Safari/537.36'
    //         ];
    //
    //         let random = Math.ceil((Math.random() * 100));
    //
    //         headers = {
    //             'Host': oSource.source,
    //             'Connection': 'keep-alive',
    //             'Pragma': 'no-cache',
    //             'Cache-Control': 'no-cache',
    //             'Upgrade-Insecure-Requests': 1,
    //             'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
    //             'Accept-Encoding': 'identity',
    //             'Accept-Language': 'en-US,en;q=0.8',
    //             'Cookie': 'bw=0; pp=r; _popfired=1',
    //             'User-Agent': userAgent[random % userAgent.length]
    //         }
    //     }
    //
    //     return options;
    // }

    private watchListStart($list: Observable<any>, removeList ) {
        return $list
            .filter((obj:{date: Date})=>{
                return !!obj.date;
            })
            .mergeMap((obj:{date: Date})=>{
                let difference = obj.date.valueOf() - Date.now();
                let time = (difference > 0? difference : 0);
                return Observable.create((obs)=>{
                    setTimeout(function(){
                        obs.next(obj);
                        obs.complete();
                    }, time);
                })
            })
            .subscribe((obj:{date: Date}) => {
                removeList(obj);
            })
    }

    //Ip LIST FUNCTIONALITY//////////////////////
    public getIpBlackList (): string[] {
        let filt =  this.allUsedIpAddresses.filter((obj:IIpObj): boolean =>{
            return !obj.date;
        });

        let filt2 = filt.map((obj: IIpObj): string=>{
            return obj.ipAddress;
        });

        return filt2;
    }
    public getIpBackoffList(): string[] {
        return this.allUsedIpAddresses.filter((obj:IIpObj): boolean =>{
            return !!obj.date;
        })
        .map((obj: IIpObj): string=>{
            return obj.ipAddress;
        })
    }

    private readIpList() {
        return this.readList(this.ipStorageLocation);
    }

    private writeIpList(ipAddress, date?: Date): Promise<void> {
        let existsList = this.allUsedIpAddresses.filter(obj=>{
            return obj.ipAddress === ipAddress;
        });

        if(existsList.length)
            return;

        let res: IIpObj = {ipAddress:ipAddress};
        if(date) {
            res.date = date;
            //watch Ip for when date expires
            this.obsExpiringIpAddresses.next(res);
        }

        this.allUsedIpAddresses.push(res);

        this.writeList(this.ipStorageLocation, this.allUsedIpAddresses)
    }

    //DISK FUNCTIONALITY////////////////////////////

    private readList(path: string) {

        if(this.options.debug)
            console.log(`RCM:readList: sync read from disk, path: ${path}`);

        try {
            let data: string = fs.readFileSync(path, {encoding: 'utf8'});
            return data && JSON.parse(data) || [];
        } catch(e) {
            return [];
        };
    }


    private writeList(path: string, list: IIpObj[]) {

        if(this.options.debug)
            console.log(`RCM:writeList: sync write to disk, path: ${path}, list: ${JSON.stringify(list)}`);

        try {
            fs.writeFileSync(path, JSON.stringify(list));
        } catch(e) {
            if(this.options.debug)
                console.log(`RCM:writeList: could not write list file, ${e}`);
        };
    }

    private _readUrlFromDisk(url: string): Promise<IPageCacheObj> {

        let rDir = url.replace(/\//g, "%").replace(/ /g, "#");
        let dir = this.options.storagePath + rDir;

        let pcObj = this.pageCache[url];
        if(pcObj && !this.testIfDateExpired(pcObj, dir)) {
            if(this.options.debug)
                console.log(`RCM:_readUrlFromDisk:pageCache: returned from page cache, url:${url}`);

            return Promise.resolve(pcObj);
        }

        return new Promise((res, rej)=> {
            fs.readFile(dir, 'utf8', (err, readOnlyObj: any) => {

                if (err) {
                    if(this.options.debug)
                        console.log(`RCM:_readUrlFromDisk:readFile: could not read from disk, dir:${dir}, error:${err}`);
                    rej(err);
                } else {
                    let obj = Object.assign({}, JSON.parse(readOnlyObj));

                    if(this.options.debug)
                        console.log(`RCM:_readUrlFromDisk: reading cache from disk success, dir: '${dir}, keys:${Object.keys(obj)}`);

                    if(this.testIfDateExpired(obj, dir)){
                        return this.deleteFile(dir).then(rej, (err)=>{
                            rej(err);
                        });
                    }

                    obj.url = url;
                    this.addPageToPageCache(obj, url);
                    res(obj);
                }
            });
        });
    }

    private testIfDateExpired(obj, dir){
        if(obj.date && !this.options.readFromDiskAlways) {

            let currentDateMills = Date.now();
            let savedDateMills = new Date(obj.date).getMilliseconds();
            if (currentDateMills > savedDateMills) {
                if(this.options.debug)
                    console.log(`RCM:_readUrlFromDisk: file read from disk had a date that expired, path: ${dir}, currentDateMills:${currentDateMills}, savedDateMills:${savedDateMills}`);
                return true;
            }
        }
        if(this.options.debug)
            console.log(`RCM:_readUrlFromDisk: file read from disk had a valid date or no date, path: ${dir}`);

        return false;
    }

    private _writeUrlToDisk(url: string, data: IPageCacheObj): Promise<IPageCacheObj> {

        let rDir = url.replace(/\//g, "%").replace(/ /g, "#");
        let dir = this.options.storagePath + rDir;

        return new Promise((res, rej)=> {
            fs.writeFile(dir, JSON.stringify(data), (err) => {
                if (err) {
                    rej(err);
                    return;
                }
                if(this.options.debug)
                    console.log(`RCM:_writeUrlToDisk: the file was written to the disk, dir: '${dir}, time:${data.date}'`);

                this.addPageToPageCache(data, url);
                res(data);
            });
        });
    }

    private addPageToPageCache(obj: IPageCacheObj, url: string){
        this.obsExpiringPageCache.next(obj);
        this.pageCache[url] = obj;
    }

    private deleteFile(path: string){
        if(this.options.debug)
            console.log(`RCM:deleteFile: requested file deletion, path: ${path}`);

        return new Promise((res,rej)=> {
            fs.unlink(path, (err) => {
                if (err) {
                    if(this.options.debug)
                        console.log(`RCM:deleteFile: error deleting file, path: ${path}`);
                    rej(err);
                    return;
                }
                res();
            });
        });
    }
}