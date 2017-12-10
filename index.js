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
            throw new Error("Databases:common:torRequest:error no storagePath defined, storagePath: " + options.storagePath);
        this.ipStorageLocation = options.storagePath + 'ipStorage';
        this.allUsedIpAddresses = this.readIpList();
        if (options.debug)
            console.log("Databases:common:torRequest, startup ip list read from the disk, " + JSON.stringify(this.allUsedIpAddresses));
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
            delete _this.pageCache[obj.url];
            _this.deleteFile(obj.url);
        });
        this.torNewSession();
    }
    RequestConsistencyMiner.prototype.torRequest = function (url, bypassCache) {
        var _this = this;
        if (bypassCache === void 0) { bypassCache = false; }
        var oSource = this.getSource(url);
        if (this.options.debug || this.options.readFromDiskAlways || (oSource.diskTimeToLive && !bypassCache)) {
            var fut_1 = new Future();
            this._readUrlFromDisk(url)
                .then(function (data) {
                if (_this.options.debug)
                    console.log("Databases:common:torRequest: file read from disk, keys: " + Object.keys(data));
                fut_1.return(data.page);
            })
                .catch(function (e) {
                if (_this.options.debug)
                    console.log("Databases:common:torRequest: file not read from disk, err: " + e);
                Fiber(function () {
                    var futureDate;
                    if (oSource.diskTimeToLive)
                        futureDate = new Date(Date.now() + oSource.diskTimeToLive);
                    var data = _this._torRequest(url);
                    return _this._writeUrlToDisk(url, { date: futureDate, page: data })
                        .then(function () {
                        fut_1.return(data);
                    }, function (err) {
                        if (_this.options.debug)
                            console.log("Databases:common:torRequest:error, _writeUrlToDisk->err:" + err);
                        fut_1.return(data);
                    }); //always return data
                }).run();
            });
            return fut_1.wait();
        }
        else {
            return this._torRequest(url);
        }
    };
    RequestConsistencyMiner.prototype._torRequest = function (url) {
        var _this = this;
        var fut = new Future();
        if (this.options.debug)
            console.log("Databases:common:torRequest: request started, url: " + url);
        var oSource = this.getSource(url);
        var newSessionCount = 0;
        this.whenIpOverUsed(oSource).then(function (initialIpAddress) {
            var ipAddress = initialIpAddress;
            function processNewSession() {
                var _this = this;
                this.torNewSession().then(function (newIpAddress) {
                    if (_this.options.debug)
                        console.log("Databases:common:torRequest:torNewSession: recieved new session 1");
                    ipAddress = newIpAddress;
                    processRequest.call(_this);
                }, function (err) {
                    if (_this.options.debug)
                        console.error("Databases:common:torRequest:error: new Session threw an error 1: err: " + err);
                });
                newSessionCount++;
            }
            ;
            function processRequest() {
                var _this = this;
                this.tr.get(url, this.randomUserHeaders(oSource), function (err, res, body) {
                    if (newSessionCount > MAX_NEW_SESSIONS) {
                        if (_this.options.debug)
                            console.error("Databases:common:torRequest:error: the maximum attempt to get a new session was reached");
                        throw new Error("Databases:common:torRequest:error: the maximum attempt to get a new session was reached, MAX_NEW_SESSIONS:" + MAX_NEW_SESSIONS);
                    }
                    if (!err && res.statusCode == 200) {
                        var pageSuccess = oSource.pageResponse(body, url, ipAddress);
                        switch (pageSuccess) {
                            case 'true':
                                _this.options._currentIpUse++;
                                if (_this.options.debug)
                                    console.error("Databases:common:torRequest page returned, currentIpUse:" + _this.options._currentIpUse);
                                fut.return(body);
                                break;
                            case 'blacklist':
                                _this.writeIpList(ipAddress);
                                if (_this.options.debug)
                                    console.error("Databases:common:torRequest Ip added to the black list, blackList:" + _this.getIpBlackList());
                                processNewSession.call(_this);
                                break;
                            default:
                                if (pageSuccess instanceof Date) {
                                    _this.writeIpList(ipAddress, pageSuccess);
                                    if (_this.options.debug)
                                        console.error("Databases:common:torRequest Ip added to the back off list, back-off list:" + _this.getIpBackoffList());
                                    processNewSession.call(_this);
                                }
                                else {
                                    throw new Error("an invalid option was returned from options." + oSource + ".pageResponse");
                                }
                        }
                    }
                    else if (err.code == 'ETIMEDOUT') {
                        if (_this.options.debug)
                            console.error("Databases:common:torRequest:error: connection timed out");
                    }
                    else {
                        if (_this.options.debug)
                            console.warn("Databases:common:torRequest:error: " + err + ", res.statusCode : " + (res && res.statusCode) + ", url: " + url);
                        processNewSession.call(_this);
                    }
                });
            }
            ;
            processRequest.call(_this);
        });
        var page = fut.wait();
        return page;
    };
    RequestConsistencyMiner.prototype.getSource = function (url) {
        if (url) {
            var start = url.indexOf('//') + 2;
            if (start < 0)
                throw new Error("Databases:common:getSource:error url did not contain a protocol, url: " + url);
            var end = url.indexOf('/', start);
            if (end < 0)
                end = url.length;
            var sourceString = url.slice(start, end);
            return this.options.sources[sourceString];
        }
        throw new Error("Databases:common:getSource:error url is not in the correct format, or no url was given, url: " + url);
    };
    RequestConsistencyMiner.prototype.whenIpOverUsed = function (oSource) {
        var ops = this.options;
        if (ops.ipUsageLimit && ops.ipUsageLimit <= ops._currentIpUse) {
            if (ops.debug)
                console.log("Databases:common:torRequest: count limit reached, source: " + oSource.source);
            return this.torNewSession();
        }
        else {
            ops._currentIpUse = ops._currentIpUse + 1 || 0;
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
        }).length > 0;
        if (hasIp) {
            return true;
        }
        else {
            return false;
        }
    };
    //USER PROVIDED FUNCTIONALITY///////////////////
    RequestConsistencyMiner.prototype.randomUserHeaders = function (oSource) {
        var headers;
        if (oSource.requestHeaders) {
            headers = oSource.requestHeaders(oSource);
        }
        else {
            var userAgent = [
                'Mozilla/5.0 (iPhone; CPU iPhone OS 9_1 like Mac OS X) AppleWebKit/601.1 (KHTML, like Gecko) CriOS/61.0.3163.100 Mobile/13B143 Safari/601.1.46',
                'Mozilla/5.0 (iPad; CPU OS 9_1 like Mac OS X) AppleWebKit/601.1 (KHTML, like Gecko) CriOS/61.0.3163.100 Mobile/13B143 Safari/601.1.46',
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/61.0.3163.100 Safari/537.36',
                'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/61.0.3163.100 Safari/537.36',
                'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/61.0.3163.100 Safari/537.36'
            ];
            var random = Math.ceil((Math.random() * 100));
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
            };
        }
        var options = {
            timeout: 60000,
            headers: headers
        };
        return options;
    };
    RequestConsistencyMiner.prototype.watchListStart = function ($list, removeList) {
        return $list
            .filter(function (obj) {
            return !!obj.date;
        })
            .mergeMap(function (obj) {
            var difference = obj.date.valueOf() - Date.now();
            var time = (difference > 0 ? difference : 0);
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
            console.log("Databases:common:readList sync read from disk, path: " + path);
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
            console.log("Databases:common:torRequest: sync write to disk, path: " + path + ", list: " + JSON.stringify(list));
        try {
            fs.writeFileSync(path, JSON.stringify(list));
        }
        catch (e) {
            if (this.options.debug)
                console.log("Databases:common:torRequest: could not write list file, " + e);
        }
        ;
    };
    RequestConsistencyMiner.prototype._readUrlFromDisk = function (url) {
        var _this = this;
        var rDir = url.replace(/\//g, "%").replace(/ /g, "#");
        var dir = this.options.storagePath + rDir;
        if (this.pageCache[url]) {
            if (this.options.debug)
                console.log("Databases:common:torRequest: returned from page cache, url:" + url);
            return Promise.resolve(this.pageCache[url]);
        }
        return new Promise(function (res, rej) {
            fs.readFile(dir, 'utf8', function (err, readOnlyObj) {
                if (err) {
                    if (_this.options.debug)
                        console.log("Databases:common:_readUrlFromDisk: could not read from disk, dir:" + dir + ", error:" + err);
                    rej(err);
                }
                else {
                    var obj = Object.assign({}, JSON.parse(readOnlyObj));
                    if (_this.options.debug)
                        console.log("Databases:common:_readUrlFromDisk: reading cache from disk success, dir: '" + dir + ", keys:" + Object.keys(obj) + "'");
                    if (obj.date) {
                        var currentDateMills = Date.now();
                        var savedDateMills = new Date(obj.date).getMilliseconds();
                        if (currentDateMills > savedDateMills) {
                            if (_this.options.debug)
                                console.log("Databases:common:_readUrlFromDisk: file read from disk had a date that expired, dir: " + dir);
                            return _this.deleteFile(dir).then(rej, function (err) {
                                rej(err);
                            });
                        }
                    }
                    obj.url = url;
                    _this.addPageToPageCache(obj, url);
                    res(obj);
                }
            });
        });
    };
    RequestConsistencyMiner.prototype._writeUrlToDisk = function (url, data) {
        var _this = this;
        var rDir = url.replace(/\//g, "%").replace(/ /g, "#");
        var dir = this.options.storagePath + rDir;
        return new Promise(function (res, rej) {
            fs.writeFile(dir, JSON.stringify(data), function (err) {
                if (err) {
                    rej(err);
                    return;
                }
                _this.addPageToPageCache(data, url);
                res(data);
            });
        });
    };
    RequestConsistencyMiner.prototype.addPageToPageCache = function (obj, url) {
        this.obsExpiringPageCache.next(obj);
        this.pageCache[url] = obj;
    };
    RequestConsistencyMiner.prototype.deleteFile = function (path) {
        if (this.options.debug)
            console.log("Databases:common:deleteFile: requested file deletion, path: " + path);
        return new Promise(function (res, rej) {
            fs.unlink(path, function (err) {
                if (err) {
                    if (this.options.debug)
                        console.log("Databases:common:deleteFile: error deleting file, path: " + path);
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