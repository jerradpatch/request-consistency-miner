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
    sources: {
        [source: string]: IRCMOptions_source
    }
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
        this.ipStorageLocation = options.storagePath + '/ipStorage';
        this.allUsedIpAddresses =  this.readIpList();

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


    public torRequest(url, recur=0): string {
        let oSource = this.getSource(url);

        if(this.options.debug || this.options.readFromDiskAlways || oSource.diskTimeToLive) { //get from disk

            let fut = new Future();
            this._readUrlFromDisk(url)
                .then((data: IPageCacheObj)=> {
                    fut.return(data);
                })
                .catch(()=> {
                    Fiber(() => {
                        let futureDate;
                        if(oSource.diskTimeToLive) {
                            futureDate = new Date(Date.now() + oSource.diskTimeToLive);
                        }

                        let data =  this._torRequest(url, recur);

                        return this._writeUrlToDisk(url, {date:futureDate, page:data})
                            .then(() => {
                                fut.return(data);
                            }, (err) => {
                                if(this.options.debug)
                                    console.log(`Databases:common:torRequest:error, _writeUrlToDisk->err:${err}`);
                                fut.return(data);
                            });//always return data
                    }).run();
                });
            return fut.wait();
        } else { //get from web
            return this._torRequest(url, recur);
        }
    }

    private _torRequest(url, recur=0): string {

        var fut = new Future();

        if(this.options.debug)
            console.log(`Databases:common:torRequest: request started, url: ${url}`);

        if(recur > 100) {
            if(this.options.debug)
                console.log(`Databases:common:torRequest:error: recur limit reached, url:${url}`);
            return null;
        }

        let oSource = this.getSource(url);

        this.whenIpOverUsed(oSource).then((initialIpAddress)=> {
            let ipAddress = initialIpAddress;

            function processNewSession() {
                this.torNewSession().then((newIpAddress) => {
                    if (this.options.debug)
                        console.log(`Databases:common:torRequest:torNewSession: recieved new session 1`);

                    ipAddress = newIpAddress;
                    processRequest.call(this);
                }, (err)=> {
                    if (this.options.debug)
                        console.error(`Databases:common:torRequest:error: new Session threw an error 1: err: ${err}`);
                });
            };

            function processRequest() {
                this.tr.get(url, this.randomUserHeaders(oSource), (err, res, body) => {
                    if (!err && res.statusCode == 200) {
                        let pageSuccess = oSource.pageResponse(body, url, ipAddress);

                        switch (pageSuccess) {
                            case 'true':
                                this.options._currentIpUse++;
                                fut.return(body);
                                break;
                            case 'blacklist':
                                this.writeIpList(ipAddress);
                                processNewSession.call(this);
                                break;
                            default:
                                if(pageSuccess instanceof Date) {
                                    this.writeIpList(ipAddress, pageSuccess);
                                    processNewSession.call(this);
                                } else {
                                    throw new Error(`an invalid option was returned from options.${oSource}.pageResponse`);
                                }
                        }

                    } else if (err.code == 'ETIMEDOUT') {
                        if (this.options.debug)
                            console.error(`Databases:common:torRequest:error: connection timed out`);

                    } else {
                        if (this.options.debug)
                            console.warn(`Databases:common:torRequest:error: ${err}, res.statusCode : ${res && res.statusCode}, url: ${url}`);

                        processNewSession.call(this);
                    }

                });
            };

            processRequest.call(this);
        });

        let page = fut.wait();
        return page;
    }

    private getSource(url: string): IRCMOptions_source {
        if(url) {
            let start = url.indexOf('//') + 2;
            let end = url.indexOf('/', start);
            let sourceString = url.slice(start, end);
            return this.options.sources[sourceString];
        }
        throw new Error(`Databases:common:getSource:error url is not in the correct format, or no url was given, url: ${url}`)
    }

    private whenIpOverUsed(oSource: IRCMOptions_source): Promise<any> {
        let ops = this.options;

        if(ops.ipUsageLimit && ops.ipUsageLimit <= ops._currentIpUse) {
            if(ops.debug)
                console.log(`Databases:common:torRequest: count limit reached, source: ${oSource.source}`);

            return this.torNewSession();
        } else {
            ops._currentIpUse = ops._currentIpUse + 1 || 0;
            return this.torReady;
        }
    }

    private gettingNewSession: boolean = false;
    private torNewSession(): Promise<any> {

        if(!this.gettingNewSession) {
            this.gettingNewSession = true;
            this.torReady = this.newIpUntilUnused()
                .then((ipAddress)=>{
                    this.options._currentIpUse = 0;
                    this.gettingNewSession = false;
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
    private randomUserHeaders(oSource: IRCMOptions_source) {
        let headers;

        if(oSource.requestHeaders) {
            headers = oSource.requestHeaders(oSource);
        } else {
            let userAgent = [
                'Mozilla/5.0 (iPhone; CPU iPhone OS 9_1 like Mac OS X) AppleWebKit/601.1 (KHTML, like Gecko) CriOS/61.0.3163.100 Mobile/13B143 Safari/601.1.46',
                'Mozilla/5.0 (iPad; CPU OS 9_1 like Mac OS X) AppleWebKit/601.1 (KHTML, like Gecko) CriOS/61.0.3163.100 Mobile/13B143 Safari/601.1.46',
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/61.0.3163.100 Safari/537.36',
                'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/61.0.3163.100 Safari/537.36',
                'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/61.0.3163.100 Safari/537.36'
            ];

            let random = Math.ceil((Math.random() * 100));

            headers = {
                'Host': oSource.source,
                'Connection': 'keep-alive',
                'Pragma': 'no-cache',
                'Cache-Control': 'no-cache',
                'Upgrade-Insecure-Requests': 1,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
                'Accept-Encoding': 'identity',
                'Accept-Language': 'en-US,en;q=0.8',
                'Cookie': 'bw=0; pp=r; _popfired=1',
                'User-Agent': userAgent[random % userAgent.length]
            }
        }

        let options = {
            timeout: 60000,
            headers: headers
        };

        return options;
    }

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
        try {
            let data: string = fs.readFileSync(path, {encoding: 'utf8'});
            return data && JSON.parse(data) || [];
        } catch(e) {
            return [];
        };
    }


    private writeList(path: string, list: IIpObj[]) {
        try {
            fs.writeFileSync(path, JSON.stringify(list));
        } catch(e) {
            if(this.options.debug)
                console.log(`could not write list file, ${e}`);
        };
    }

    private _readUrlFromDisk(url: string): Promise<IPageCacheObj> {

        let rDir = url.replace(/\//g, "%").replace(/ /g, "#");
        let dir = this.options.storagePath + rDir;


        if(this.pageCache[url]) {
            if(this.options.debug)
                console.log(`Databases:common:torRequest: returned from page cache, url:${url}`);

            return Promise.resolve(this.pageCache[url]);
        }

        return new Promise((res, rej)=> {
            fs.readFile(dir, 'utf8', (err, obj: any) => {
                if (err) {
                    if(this.options.debug)
                        console.log(`Databases:common:_readUrlFromDisk: could not read from disk, dir:${dir}, error:${err}`);
                    rej(err);
                } else {
                    if(this.options.debug)
                        console.log(`Databases:common:_readUrlFromDisk: reading cache from disk success, dir: ${dir}`);

                    if(obj.date) {
                        let currentDateMills = Date.now();
                        let savedDateMills = obj.date.getMilliseconds();
                        if (currentDateMills > savedDateMills) {
                            if(this.options.debug)
                                console.log(`Databases:common:_readUrlFromDisk: file read from disk had a date that expired, dir: ${dir}`);
                            return this.deleteFile(dir).then(rej, (err)=>{
                                rej(err);
                            });
                        }
                    }

                    obj.url = url;
                    this.addPageToPageCache(obj, url);
                    res(obj);
                }
            });
        });
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
        return new Promise((res,rej)=> {
            fs.unlink(path, function (err) {
                if (err) {
                    rej(err);
                    return;
                }
                res();
            });
        });
    }
}