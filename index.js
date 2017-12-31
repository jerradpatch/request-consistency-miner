"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var tor_request_1 = require("tor-request");
var Future = require("fibers/future");
var Fiber = require("fibers/fibers");
var fs = require("fs");
var Rx_1 = require("rxjs/Rx");
;
;
;
var MAX_NEW_SESSIONS = 100;
var RequestConsistencyMiner = /** @class */ (function () {
    function RequestConsistencyMiner(options, torClientOptions) {
        var _this = this;
        this.options = options;
        this.torClientOptions = torClientOptions;
        this.allUsedIpAddresses = [];
        this.obsExpiringIpAddresses = new Rx_1.Subject();
        this.pageCache = {};
        this.obsExpiringPageCache = new Rx_1.Subject();
        this.gettingNewSession = false;
        if (!options.storagePath)
            throw new Error("RCM:constructor:error no storagePath defined, storagePath: " + options.storagePath);
        this.ipStorageLocation = options.storagePath + 'ipStorage';
        this.allUsedIpAddresses = this.readIpList();
        if (options.debug)
            console.log("RCM:constructor, startup ip list read from the disk, " + JSON.stringify(this.allUsedIpAddresses));
        this.tcc = new tor_request_1.TorClientControl(torClientOptions);
        this.tr = new tor_request_1.TorRequest();
        this.watchListStart(this.obsExpiringIpAddresses, function (obj) {
            var i = 0;
            while (i !== _this.allUsedIpAddresses.length) {
                if (_this.allUsedIpAddresses[i].ipAddress === obj.ipAddress) {
                    _this.allUsedIpAddresses.splice(i, 1);
                }
                else {
                    i++;
                }
            }
        });
        this.watchListStart(this.obsExpiringPageCache, function (obj) {
            if (_this.options.debug)
                console.warn("RCM:watchListStart: deleting due to date exipration,CurrentDate:" + new Date() + ", SavedDate:" + obj.date + ", obj:" + JSON.stringify(obj));
            delete _this.pageCache[obj.url];
            var dir = _this.urlToDir(obj.url);
            _this.deleteFile(dir);
        });
        this.torNewSession();
    }
    RequestConsistencyMiner.prototype.torRequest = function (oSource) {
        var _this = this;
        if (!oSource || !oSource.source || !oSource.pageResponse)
            throw new Error("RCM:torRequest:error, the required properties of the 'IRCMOptions_source' were not set, oSource:" + JSON.stringify(oSource));
        var url = oSource.source;
        if (this.options.readFromDiskAlways || oSource.diskTimeToLive) {
            var fut_1 = new Future();
            this._readUrlFromDisk(url)
                .then(function (data) {
                if (_this.options.debug)
                    console.log("RCM:torRequest: file read from disk, keys: " + Object.keys(data));
                fut_1.return(data.page);
            })
                .catch(function (e) {
                if (_this.options.debug)
                    console.warn("RCM:torRequest: file not read from disk, err: " + e + ", oSource:" + JSON.stringify(oSource));
                Fiber(function () {
                    var data = _this._torRequest(oSource);
                    var obj = { page: data, url: url };
                    if (oSource.diskTimeToLive) {
                        obj['date'] = new Date(Date.now() + oSource.diskTimeToLive);
                    }
                    return _this._writeUrlToDisk(obj)
                        .then(function () {
                        fut_1.return(data);
                    }, function (err) {
                        if (_this.options.debug)
                            console.log("RCM:torRequest:error, _writeUrlToDisk->err:" + err);
                        fut_1.return(data);
                    }); //always return data
                }).run();
            });
            return fut_1.wait();
        }
        else {
            return this._torRequest(oSource);
        }
    };
    RequestConsistencyMiner.prototype._torRequest = function (oSource) {
        var _this = this;
        var url = oSource.source;
        var fut = new Future();
        if (this.options.debug)
            console.log("RCM:_torRequest: request started, url: " + url);
        var newSessionCount = 0;
        var options = {
            timeout: 60000
        };
        fixHeaders(oSource, options);
        this.whenIpOverUsed(oSource).then(function (initialIpAddress) {
            var ipAddress = initialIpAddress;
            function processNewSession() {
                var _this = this;
                this.torNewSession().then(function (newIpAddress) {
                    if (_this.options.debug)
                        console.log("RCM:_torRequest:torNewSession: recieved new session 1");
                    ipAddress = newIpAddress;
                    processRequest.call(_this);
                }, function (err) {
                    if (_this.options.debug)
                        console.error("RCM:_torRequest:processNewSession:error: new Session threw an error 1: err: " + err);
                });
                newSessionCount++;
            }
            ;
            function processRequest() {
                var _this = this;
                this.tr.get(url, options, function (err, res, body) {
                    if (newSessionCount > MAX_NEW_SESSIONS) {
                        if (_this.options.debug)
                            console.error("RCM:_torRequest:processRequest:error: the maximum attempt to get a new session was reached");
                        throw new Error("RCM:_torRequest:processRequest:error: the maximum attempt to get a new session was reached, MAX_NEW_SESSIONS:" + MAX_NEW_SESSIONS);
                    }
                    if (!err && res.statusCode == 200) {
                        var pageSuccess = oSource.pageResponse(body, url, ipAddress);
                        switch (pageSuccess) {
                            case 'true':
                                _this.options._currentIpUse++;
                                if (_this.options.debug)
                                    console.log("RCM:_torRequest:processRequest page returned, currentIpUse:" + ipAddress + ", source:" + oSource.source);
                                fut.return(body);
                                break;
                            case 'blacklist':
                                _this.writeIpList(ipAddress);
                                if (_this.options.debug)
                                    console.error("RCM:_torRequest:processRequest Ip added to the black list, blackList:" + _this.getIpBlackList() + ", body:" + body);
                                processNewSession.call(_this);
                                break;
                            default:
                                if (pageSuccess instanceof Date) {
                                    _this.writeIpList(ipAddress, pageSuccess);
                                    if (_this.options.debug)
                                        console.error("RCM:_torRequest:processRequest Ip added to the back off list, back-off list:" + _this.getIpBackoffList());
                                    processNewSession.call(_this);
                                }
                                else {
                                    fut.throw(new Error("RCM:_torRequest:processRequest, an invalid option was returned from pageResponse():" + pageSuccess + ". Date/'blacklist'/'true'"));
                                }
                        }
                    }
                    else if (err && err.code == 'ETIMEDOUT') {
                        if (_this.options.debug)
                            console.error("RCM:_torRequest:processRequest:error: connection timed out");
                    }
                    else {
                        fut.throw(new Error("RCM:_torRequest:processRequest:error: " + err + ", res.statusCode : " + (res && res.statusCode) + ", \n\r oSource: " + JSON.stringify(oSource) + ", \n\r options:" + JSON.stringify(options)));
                        // if (this.options.debug)
                        //     console.warn(`RCM:_torRequest:processRequest:error: ${err}, res.statusCode : ${res && res.statusCode}, \n\r oSource: ${JSON.stringify(oSource)}, \n\r options:${JSON.stringify(options)}`);
                        // processNewSession.call(this);
                    }
                });
            }
            ;
            processRequest.call(_this);
        });
        function fixHeaders(sour, ops) {
            if (sour.requestHeaders) {
                var headers = sour.requestHeaders(sour);
                var host = headers['Host'] || headers['host'];
                if (host) {
                    if (host.indexOf('http://') === 0) {
                        host = host.slice('http://'.length);
                    }
                    else if (host.indexOf('https://') === 0) {
                        host = host.slice('https://'.length);
                    }
                    var endOfDomain = host.indexOf('/');
                    if (endOfDomain > 0)
                        host = host.slice(0, endOfDomain);
                    headers['Host'] = host;
                    delete headers['host'];
                }
                ops['headers'] = headers;
            }
        }
        var page = fut.wait();
        return page;
    };
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
    RequestConsistencyMiner.prototype.whenIpOverUsed = function (oSource) {
        var ops = this.options;
        if (ops.ipUsageLimit && ops.ipUsageLimit <= ops._currentIpUse) {
            if (ops.debug)
                console.log("RCM:whenIpOverUsed: count limit reached, source: " + oSource.source);
            return this.torNewSession();
        }
        else {
            ops._currentIpUse = ops._currentIpUse + 1 || 0;
            if (ops.debug)
                console.log("RCM:whenIpOverUsed: current ipUsed#, source: " + oSource.source + ", _currentIpUse #: " + ops._currentIpUse);
            return this.torReady;
        }
    };
    RequestConsistencyMiner.prototype.torNewSession = function () {
        var _this = this;
        if (!this.gettingNewSession) {
            this.gettingNewSession = true;
            this.torReady = this.newIpUntilUnused()
                .then(function (ipAddress) {
                _this.options._currentIpUse = 0;
                _this.gettingNewSession = false;
                _this.tr;
                return ipAddress;
            });
        }
        return this.torReady;
    };
    RequestConsistencyMiner.prototype.newIpUntilUnused = function () {
        return this.tcc.newTorSession().toPromise().then(function (ipAddress) {
            if (!ipAddress) {
                return ipAddress;
            }
            else {
                var isUsed = this.ifIpAlreadyUsed(ipAddress);
                if (isUsed) {
                    return this.newIpUntilUnused();
                }
                else {
                    return ipAddress;
                }
            }
        }.bind(this), function (err) {
            return this.newIpUntilUnused();
        }.bind(this));
    };
    RequestConsistencyMiner.prototype.ifIpAlreadyUsed = function (ipAddress) {
        var hasIp = this.allUsedIpAddresses.filter(function (used) {
            return used.ipAddress === ipAddress;
        });
        var found = hasIp.length > 0;
        if (this.options.debug) {
            if (found) {
                console.log("RCM:ifIpAlreadyUsed: ip existed, ipSearchingFor:" + ipAddress + ", allUsedIpAddress:" + JSON.stringify(this.allUsedIpAddresses));
            }
            else {
                console.log("RCM:ifIpAlreadyUsed: ip was not found, ipSearchingFor:" + ipAddress + ", allUsedIpAddress:" + JSON.stringify(this.allUsedIpAddresses));
            }
        }
        return found;
    };
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
    RequestConsistencyMiner.prototype.watchListStart = function ($list, removeList) {
        var _this = this;
        return $list
            .filter(function (obj) {
            return !!obj.date;
        })
            .mergeMap(function (obj) {
            var difference = obj.date.valueOf() - Date.now();
            var time = (difference > 0 ? difference : 0);
            if (_this.options.debug)
                console.log("RCM:watchListStart: setTimeout to deletion, time:" + time + ", obj.date:" + obj.date + ", date.now:" + Date.now() + ", obj.url:" + obj.url);
            return Rx_1.Observable.create(function (obs) {
                setTimeout(function () {
                    obs.next(obj);
                    obs.complete();
                }, time);
            });
        })
            .subscribe(function (obj) {
            removeList(obj);
        });
    };
    //Ip LIST FUNCTIONALITY//////////////////////
    RequestConsistencyMiner.prototype.getIpBlackList = function () {
        var filt = this.allUsedIpAddresses.filter(function (obj) {
            return !obj.date;
        });
        var filt2 = filt.map(function (obj) {
            return obj.ipAddress;
        });
        return filt2;
    };
    RequestConsistencyMiner.prototype.getIpBackoffList = function () {
        return this.allUsedIpAddresses.filter(function (obj) {
            return !!obj.date;
        })
            .map(function (obj) {
            return obj.ipAddress;
        });
    };
    RequestConsistencyMiner.prototype.readIpList = function () {
        return this.readList(this.ipStorageLocation);
    };
    RequestConsistencyMiner.prototype.writeIpList = function (ipAddress, date) {
        var existsList = this.allUsedIpAddresses.filter(function (obj) {
            return obj.ipAddress === ipAddress;
        });
        if (existsList.length)
            return;
        var res = { ipAddress: ipAddress };
        if (date) {
            res.date = date;
            //watch Ip for when date expires
            this.obsExpiringIpAddresses.next(res);
        }
        this.allUsedIpAddresses.push(res);
        this.writeList(this.ipStorageLocation, this.allUsedIpAddresses);
    };
    //DISK FUNCTIONALITY////////////////////////////
    RequestConsistencyMiner.prototype.readList = function (path) {
        if (this.options.debug)
            console.log("RCM:readList: sync read from disk, path: " + path);
        try {
            var data = fs.readFileSync(path, { encoding: 'utf8' });
            return data && JSON.parse(data) || [];
        }
        catch (e) {
            return [];
        }
        ;
    };
    RequestConsistencyMiner.prototype.writeList = function (path, list) {
        if (this.options.debug)
            console.log("RCM:writeList: sync write to disk, path: " + path + ", list: " + JSON.stringify(list));
        try {
            fs.writeFileSync(path, JSON.stringify(list));
        }
        catch (e) {
            if (this.options.debug)
                console.log("RCM:writeList: could not write list file, " + e);
        }
        ;
    };
    RequestConsistencyMiner.prototype._readUrlFromDisk = function (url) {
        var _this = this;
        var dir = this.urlToDir(url);
        var pcObj = this.pageCache[url];
        if (pcObj && !this.testIfDateExpired(pcObj, dir)) {
            if (this.options.debug)
                console.log("RCM:_readUrlFromDisk:pageCache: returned from page cache, url:" + url);
            return Promise.resolve(pcObj);
        }
        return new Promise(function (res, rej) {
            fs.readFile(dir, 'utf8', function (err, readOnlyObj) {
                if (err) {
                    if (_this.options.debug)
                        console.log("RCM:_readUrlFromDisk:readFile: could not read from disk, dir:" + dir + ", error:" + err);
                    rej(err);
                }
                else {
                    var obj = Object.assign({}, JSON.parse(readOnlyObj));
                    if (_this.options.debug)
                        console.log("RCM:_readUrlFromDisk: reading cache from disk success, dir: '" + dir + ", keys:" + Object.keys(obj));
                    if (_this.testIfDateExpired(obj, dir)) {
                        if (_this.options.debug)
                            console.warn("RCM:_readUrlFromDisk: deleting due to date exipration, obj:" + JSON.stringify(obj) + ", currentDate:" + new Date());
                        return _this.deleteFile(dir).then(rej, function (err) {
                            rej(err);
                        });
                    }
                    obj.url = url;
                    _this.addPageToPageCache(obj);
                    res(obj);
                }
            });
        });
    };
    RequestConsistencyMiner.prototype.urlToDir = function (url) {
        var rDir = url.replace(/\//g, "%").replace(/ /g, "#");
        var dir = this.options.storagePath + rDir;
        return dir;
    };
    RequestConsistencyMiner.prototype.testIfDateExpired = function (obj, dir) {
        if (obj.date && !this.options.readFromDiskAlways) {
            var currentDateMills = Date.now();
            var savedDateMills = new Date(obj.date).getMilliseconds();
            if (currentDateMills > savedDateMills) {
                if (this.options.debug)
                    console.log("RCM:_readUrlFromDisk: file read from disk had a date that expired, path: " + dir + ", currentDateMills:" + currentDateMills + ", savedDateMills:" + savedDateMills);
                return true;
            }
        }
        if (this.options.debug)
            console.log("RCM:_readUrlFromDisk: file read from disk had a valid date or no date defined (cached forever), path: " + dir);
        return false;
    };
    RequestConsistencyMiner.prototype._writeUrlToDisk = function (data) {
        var _this = this;
        var rDir = data.url.replace(/\//g, "%").replace(/ /g, "#");
        var dir = this.options.storagePath + rDir;
        return new Promise(function (res, rej) {
            fs.writeFile(dir, JSON.stringify(data), function (err) {
                if (err) {
                    rej(err);
                    return;
                }
                if (_this.options.debug)
                    console.log("RCM:_writeUrlToDisk: the file was written to the disk, dir: '" + dir + ", time:" + data.date + "'");
                _this.addPageToPageCache(data);
                res(data);
            });
        });
    };
    RequestConsistencyMiner.prototype.addPageToPageCache = function (obj) {
        this.obsExpiringPageCache.next(obj);
        this.pageCache[obj.url] = obj;
    };
    RequestConsistencyMiner.prototype.deleteFile = function (path) {
        var _this = this;
        if (this.options.debug)
            console.log("RCM:deleteFile: requested file deletion, path: " + path);
        return new Promise(function (res, rej) {
            fs.unlink(path, function (err) {
                if (err) {
                    if (_this.options.debug)
                        console.log("RCM:deleteFile: error deleting file, path: " + path + ", err:" + err);
                    rej(err);
                    return;
                }
                res();
            });
        });
    };
    RequestConsistencyMiner.MAX_NEW_SESSIONS = 100;
    return RequestConsistencyMiner;
}());
exports.RequestConsistencyMiner = RequestConsistencyMiner;
//# sourceMappingURL=index.js.map