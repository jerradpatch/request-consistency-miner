"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var mkdirp = require("mkdirp");
var fs = require("fs");
var Fiber = require("fibers/fibers");
var Rx_1 = require("rxjs/Rx");
var rewiremock_1 = require("rewiremock");
//setup mocks
var syncWrite = null;
var asycWrite = null;
var asycContentsRead = false;
var requestHeaders = null;
function mockFs(contents) {
    rewiremock_1.default('fs')
        .with({
        readFileSync: function () {
            return contents;
        },
        writeFileSync: function (path, data) {
            syncWrite = data;
        },
        readFile: function (a, b, c) {
            asycContentsRead = true;
            c(null, contents);
        },
        writeFile: function (path, data, func) {
            asycWrite = data;
            func();
        },
        unlink: function (path, err) {
            asycWrite = null;
        }
    });
}
function mockFs_emptyDisk(contents) {
    rewiremock_1.default('fs')
        .with({
        readFileSync: function () {
            return null;
        },
        writeFileSync: function (path, data) {
            syncWrite = data;
        },
        readFile: function (a, b, c) {
            asycContentsRead = true;
            throw "err";
        },
        writeFile: function (path, data, func) {
            asycWrite = data;
            func();
        },
        unlink: function (path, err) {
            asycWrite = null;
        }
    });
}
function mockTR(ipAddresses, returnedContent) {
    var i = 0;
    rewiremock_1.default('tor-request')
        .with({
        TorRequest: function () {
            return {
                get: function (uri, options, callback) {
                    if (callback)
                        requestHeaders = options.headers;
                    callback(null, { statusCode: 200 }, returnedContent || "");
                }
            };
        },
        TorClientControl: function () {
            return {
                newTorSession: function () {
                    i = (i > ipAddresses.length - 1 ? ipAddresses.length - 1 : i);
                    return Rx_1.Observable
                        .of(ipAddresses[i])
                        .delay(100)
                        .do(function (ip) {
                        i++;
                    })
                        .take(1);
                }
            };
        }
    });
}
describe('testing all the different options', function () {
    this.timeout(15000);
    beforeEach(function () {
        syncWrite = null;
        asycWrite = null;
        asycContentsRead = false;
        requestHeaders = null;
    });
    var fileContents = { page: "this was read from the file" };
    var torClientOptions = {
        "debug": true,
        "password": "LoveMaoMao1234",
        "host": "localhost",
        "controlPort": 9051,
        "socksPort": 9050,
        "type": 5
    };
    // ipBlackList: Function(page: string): boolean,
    var sourceUrl = "noplace.eu";
    function createRcmOptions(ops) {
        ops.storagePath = "~/tmp/rcmStorage";
        return ops;
    }
    function isPageSuccessful(body, url, ipAddress) {
        if (body.indexOf("Page view limit exceeded") != -1) {
            console.log("Databases:common:torRequest: Page view limit exceeded, url: " + url);
            return 'backoff';
        }
        else if (body.indexOf("blacklisted") != -1) {
            console.log("Databases:common:torRequest: Ip blacklisted because of server abuse");
            return 'blacklist';
        }
        else if (body.length < 3000) {
            console.log("Databases:common:torRequest: page did not meet minimum length, url: " + url);
            return 'blacklist';
        }
        else if (body.indexOf("type='video/mp4'") == -1) {
            console.log("Databases:common:torRequest: no video tag found, url: " + url);
            return 'blacklist';
        }
        else {
            console.log("Databases:common:torRequest: success, url: " + url);
            return 'true';
        }
    }
    function randomUserHeaders(oSource) {
        var userAgent = [
            'Mozilla/5.0 (iPhone; CPU iPhone OS 9_1 like Mac OS X) AppleWebKit/601.1 (KHTML, like Gecko) CriOS/61.0.3163.100 Mobile/13B143 Safari/601.1.46',
            'Mozilla/5.0 (iPad; CPU OS 9_1 like Mac OS X) AppleWebKit/601.1 (KHTML, like Gecko) CriOS/61.0.3163.100 Mobile/13B143 Safari/601.1.46',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/61.0.3163.100 Safari/537.36',
            'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/61.0.3163.100 Safari/537.36',
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/61.0.3163.100 Safari/537.36'
        ];
        var random = Math.ceil((Math.random() * 100));
        var headers = {
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
        return headers;
    }
    describe('storageUrl, storage folder should be set with read and write permissions', function () {
        it('should return without error', function (done) {
            var rcmOptions = createRcmOptions({
                debug: true,
                readFromDiskAlways: false,
                ipUsageLimit: 20,
                sources: (_a = {},
                    _a[sourceUrl] = {
                        source: 'sourceUrl',
                        diskTimeToLive: 60 * 1000,
                        requestHeaders: randomUserHeaders,
                        pageResponse: isPageSuccessful
                    },
                    _a)
            });
            var path = rcmOptions.storagePath;
            mkdirp(path, function (err) {
                if (err)
                    throw new Error("couldnt create directory");
                fs.access(path, fs.constants.R_OK | fs.constants.W_OK, function (err) {
                    if (err)
                        throw new Error("read and write permissions are needed on storagePath");
                    done();
                });
            });
            var _a;
        });
    });
    describe('readFromDiskWhenDebug, should read from disk when debug is set true', function () {
        it('should return without error', function (done) {
            var rcmOptions = createRcmOptions({
                debug: true,
                readFromDiskAlways: false,
                ipUsageLimit: 20,
                sources: (_a = {},
                    _a[sourceUrl] = {
                        source: 'sourceUrl',
                        diskTimeToLive: 60 * 1000,
                        requestHeaders: randomUserHeaders,
                        pageResponse: isPageSuccessful
                    },
                    _a)
            });
            rewiremock_1.default.inScope(function () {
                mockFs(fileContents);
                mockTR([""]);
                rewiremock_1.default.enable();
                var RCM = require('../index');
                var rcm = new RCM.RequestConsistencyMiner(rcmOptions, torClientOptions);
                Fiber(function () {
                    var page = rcm.torRequest('http://' + sourceUrl + '/');
                    if (!page || page !== fileContents)
                        throw new Error("the file contents did not match the page fetched, pageReturned: " + page);
                    done();
                }).run();
                rewiremock_1.default.disable();
            });
            var _a;
        });
    });
    describe('readFromDiskWhenDebug, should not read from disk when debug is set false', function () {
        it('should return without error', function (done) {
            var rcmOptions = createRcmOptions({
                debug: false,
                readFromDiskAlways: false,
                ipUsageLimit: 20,
                sources: (_a = {},
                    _a[sourceUrl] = {
                        source: 'sourceUrl',
                        diskTimeToLive: 60 * 1000,
                        requestHeaders: randomUserHeaders,
                        pageResponse: isPageSuccessful
                    },
                    _a)
            });
            rewiremock_1.default.inScope(function () {
                mockFs(fileContents);
                rewiremock_1.default.enable();
                var RCM = require('../index');
                var rcm = new RCM.RequestConsistencyMiner(rcmOptions, torClientOptions);
                Fiber(function () {
                    var page = rcm.torRequest('http://' + sourceUrl + '/');
                    if (!page || page !== fileContents)
                        throw new Error("the file contents did not match the page fetched, pageReturned: " + page);
                    done();
                }).run();
                rewiremock_1.default.disable();
            });
            var _a;
        });
    });
    describe('source.ipBlackList, should ask for a new IP when function returns "blacklisted" ', function () {
        it('should return without error', function (done) {
            var blacklistedIp = "1.1.1.1";
            var rcmOptions = createRcmOptions({
                debug: false,
                readFromDiskAlways: false,
                ipUsageLimit: 20,
                sources: (_a = {},
                    _a[sourceUrl] = {
                        source: 'sourceUrl',
                        requestHeaders: randomUserHeaders,
                        pageResponse: function (body, url, ipAddress) {
                            if (ipAddress === blacklistedIp) {
                                return "blacklist";
                            }
                            else {
                                return 'true';
                            }
                        }
                    },
                    _a)
            });
            rewiremock_1.default.inScope(function () {
                mockFs(fileContents);
                //set currentIp
                mockTR([blacklistedIp, "2.2.2.2"]);
                rewiremock_1.default.enable();
                var RCM = require('../index');
                Fiber(function () {
                    var rcm = new RCM.RequestConsistencyMiner(rcmOptions, torClientOptions);
                    //request page
                    var page = rcm.torRequest('http://' + sourceUrl + '/');
                    //check that the black list only contains the blacklisted IP
                    var blist = rcm.getIpBlackList();
                    if (!blist || blist.length != 1 || blist[0] !== blacklistedIp)
                        throw new Error("the black list didn't contain expected, expected:" + [blacklistedIp] + ", result:" + JSON.stringify(blist));
                    if (!syncWrite || syncWrite !== JSON.stringify([{ "ipAddress": blacklistedIp }]))
                        throw new Error("the ip blacklist was not written to disk, expected:" + [{ "ipAddress": blacklistedIp }] + ", result:" + syncWrite);
                    done();
                }).run();
                rewiremock_1.default.disable();
            });
            var _a;
        });
    });
    describe('source.ipUsageLimit, should ask for a new Ip address after resource request limit/backoff reached', function () {
        it('should return without error', function (done) {
            var rcmOptions = createRcmOptions({
                debug: false,
                readFromDiskAlways: false,
                ipUsageLimit: 1,
                sources: (_a = {},
                    _a[sourceUrl] = {
                        source: 'sourceUrl',
                        requestHeaders: randomUserHeaders,
                        pageResponse: function (body, url, ipAddress) {
                            return 'true';
                        }
                    },
                    _a)
            });
            rewiremock_1.default.inScope(function () {
                mockFs(fileContents);
                //set currentIp
                mockTR(["1.1.1.1", "2.2.2.2"]); //needs a enough new IPs per expected fetch new IP
                rewiremock_1.default.enable();
                var RCM = require('../index');
                Fiber(function () {
                    var rcm = new RCM.RequestConsistencyMiner(rcmOptions, torClientOptions);
                    //request page
                    var page = rcm.torRequest('http://' + sourceUrl + '/');
                    page = rcm.torRequest('http://' + sourceUrl + '/');
                    if (!rcmOptions._currentIpUse || rcmOptions._currentIpUse !== 1)
                        throw new Error("the number of new Ip's requested does not is not 1, rcmOptions._currentIpUse:" + rcmOptions._currentIpUse);
                    done();
                }).run();
                rewiremock_1.default.disable();
            });
            var _a;
        });
    });
    describe('source.ipUsageLimit, after usage limit reached it should add ip to backoff list and set a timeout', function () {
        it('should return without error', function (done) {
            var nonBackOffIp = "2.2.2.2";
            var backOffIp = "1.1.1.1";
            var ipBackoffTimeout = 500;
            var rcmOptions = createRcmOptions({
                debug: false,
                readFromDiskAlways: false,
                ipUsageLimit: 1,
                sources: (_a = {},
                    _a[sourceUrl] = {
                        source: 'sourceUrl',
                        requestHeaders: randomUserHeaders,
                        pageResponse: function (body, url, ipAddress) {
                            if (ipAddress === backOffIp) {
                                return new Date(Date.now() + ipBackoffTimeout);
                            }
                            else {
                                return 'true';
                            }
                        }
                    },
                    _a)
            });
            rewiremock_1.default.inScope(function () {
                mockFs(fileContents);
                //set currentIp
                mockTR([backOffIp, nonBackOffIp]); //needs a enough new IPs per expected fetch new IP
                rewiremock_1.default.enable();
                var RCM = require('../index');
                Fiber(function () {
                    var rcm = new RCM.RequestConsistencyMiner(rcmOptions, torClientOptions);
                    //request page
                    rcm.torRequest('http://' + sourceUrl + '/');
                    var backOffIps = rcm.getIpBackoffList();
                    if (backOffIps.length !== 1 && backOffIps[0] !== backOffIp)
                        throw new Error("backoff IpAddresses are not the count expected, expected 1, actual=" + (backOffIps && backOffIps.length));
                    setTimeout(function () {
                        backOffIps = rcm.getIpBackoffList();
                        if (backOffIps.length !== 0)
                            throw new Error("backoff IpAddresses are not the count expected, expected 0, actual=" + (backOffIps && backOffIps.length));
                        done();
                    }, ipBackoffTimeout + 100);
                }).run();
                rewiremock_1.default.disable();
            });
            var _a;
        });
    });
    describe('source.ipUsageLimit, after usage limit reached and set timeout expires, it should reuse previous IP address', function () {
        it('should return without error', function (done) {
            var firstIp = "1.1.1.1";
            var secondIp = "2.2.2.2";
            var ipBackoffTimeout = 100;
            var requestCount = 0;
            var currentIp = '';
            var rcmOptions = createRcmOptions({
                debug: false,
                readFromDiskAlways: false,
                ipUsageLimit: 100,
                sources: (_a = {},
                    _a[sourceUrl] = {
                        source: 'sourceUrl',
                        requestHeaders: randomUserHeaders,
                        pageResponse: function (body, url, ipAddress) {
                            currentIp = ipAddress;
                            var ret;
                            if (requestCount === 0 || requestCount === 1) {
                                ret = new Date(Date.now() + ipBackoffTimeout);
                            }
                            else {
                                ret = 'true';
                            }
                            requestCount++;
                            return ret;
                        }
                    },
                    _a)
            });
            rewiremock_1.default.inScope(function () {
                mockFs(fileContents);
                //set currentIp
                mockTR([firstIp, secondIp, firstIp]); //needs a enough new IPs per expected fetch new IP
                rewiremock_1.default.enable();
                var RCM = require('../index');
                Fiber(function () {
                    var rcm = new RCM.RequestConsistencyMiner(rcmOptions, torClientOptions);
                    //request page
                    //it will backoff first, back off second, keep getting first, until timer, ticks and removes first, then it
                    // it will complete and return
                    rcm.torRequest('http://' + sourceUrl + '/');
                    if (requestCount !== 3)
                        throw new Error("requestCount, expected:3, actual:" + requestCount);
                    if (currentIp !== firstIp)
                        throw new Error("firstIp, expected:3, actual:" + requestCount);
                    done();
                    rewiremock_1.default.disable();
                }).run();
            });
            var _a;
        });
    });
    describe('source.diskTimeToLive, after a request is made, the request should be persisted to the disk space with a time to live set', function () {
        it('should return without error', function (done) {
            var rcmOptions = createRcmOptions({
                debug: false,
                readFromDiskAlways: false,
                ipUsageLimit: 100,
                sources: (_a = {},
                    _a[sourceUrl] = {
                        source: 'sourceUrl',
                        diskTimeToLive: 1000,
                        requestHeaders: randomUserHeaders,
                        pageResponse: function (body, url, ipAddress) {
                            return 'true';
                        }
                    },
                    _a)
            });
            rewiremock_1.default.inScope(function () {
                mockFs_emptyDisk(fileContents);
                //set currentIp
                mockTR(["1.1.1.1"]); //needs a enough new IPs per expected fetch new IP
                rewiremock_1.default.enable();
                var RCM = require('../index');
                Fiber(function () {
                    var rcm = new RCM.RequestConsistencyMiner(rcmOptions, torClientOptions);
                    rcm.torRequest('http://' + sourceUrl + '/');
                    //timeout for async event to complete
                    setTimeout(function () {
                        var diskObj = JSON.parse(asycWrite);
                        if (diskObj.date === 'undefined' || diskObj.page === 'undefined')
                            throw new Error("fileContents, expect:" + fileContents + ", actual:" + asycWrite);
                        rewiremock_1.default.disable();
                        done();
                    }, 500);
                }).run();
            });
            var _a;
        });
    });
    describe('source.diskTimeToLive, the request should return a different page after the disk time-to-live expired', function () {
        it('should return without error', function (done) {
            var timeoutBeforeDiskCacheCleared = 1000;
            var returnedPageData = "dummy text to be cleared via a write to the disk from 'diskTimeToLive' timeout";
            var rcmOptions = createRcmOptions({
                debug: false,
                readFromDiskAlways: false,
                ipUsageLimit: 100,
                sources: (_a = {},
                    _a[sourceUrl] = {
                        source: 'sourceUrl',
                        diskTimeToLive: 1000,
                        requestHeaders: randomUserHeaders,
                        pageResponse: function (body, url, ipAddress) {
                            return 'true';
                        }
                    },
                    _a)
            });
            rewiremock_1.default.inScope(function () {
                mockFs_emptyDisk(null);
                //set currentIp
                mockTR(["1.1.1.1"], returnedPageData); //needs a enough new IPs per expected fetch new IP
                rewiremock_1.default.enable();
                var RCM = require('../index');
                Fiber(function () {
                    var rcm = new RCM.RequestConsistencyMiner(rcmOptions, torClientOptions);
                    rcm.torRequest('http://' + sourceUrl + '/');
                    if (!asycContentsRead)
                        throw new Error("asycContentsRead, the disk should have been attempted to have been read from, expect:true, actual:" + asycContentsRead);
                    setTimeout(function () {
                        if (!asycWrite || JSON.parse(asycWrite).page !== returnedPageData)
                            throw new Error("asycWrite, the disk should have been attempted to have been written to with page data from, expect:" + returnedPageData + ", actual:" + asycWrite);
                        //disk should contain cached page
                        setTimeout(function () {
                            if (asycWrite)
                                throw new Error("asycWrite, contents should have been cleared from the disk when the 'diskTimeToLive' expired, expect:null, actual:" + asycWrite);
                            rewiremock_1.default.disable();
                            done();
                        }, timeoutBeforeDiskCacheCleared + 100);
                    }, 0);
                }).run();
            });
            var _a;
        });
    });
    describe('source.requestHeaders, a request should be made with the given headers', function () {
        it('should return without error', function (done) {
            var expectedHeaders = randomUserHeaders({ source: sourceUrl });
            var rcmOptions = createRcmOptions({
                debug: false,
                readFromDiskAlways: false,
                ipUsageLimit: 100,
                sources: (_a = {},
                    _a[sourceUrl] = {
                        source: sourceUrl,
                        requestHeaders: function () {
                            return expectedHeaders;
                        },
                        pageResponse: function (body, url, ipAddress) {
                            return 'true';
                        }
                    },
                    _a)
            });
            rewiremock_1.default.inScope(function () {
                mockFs_emptyDisk(null);
                //set currentIp
                mockTR(["1.1.1.1", "2.2.2.2"]); //needs a enough new IPs per expected fetch new IP
                rewiremock_1.default.enable();
                var RCM = require('../index');
                Fiber(function () {
                    var rcm = new RCM.RequestConsistencyMiner(rcmOptions, torClientOptions);
                    rcm.torRequest('http://' + sourceUrl + '/');
                    var eSt = JSON.stringify(expectedHeaders);
                    var rSt = JSON.stringify(requestHeaders);
                    if (eSt !== rSt)
                        throw new Error("expectedHeaders, the expected headers does not match the expected headers for the http request, expectedHeaders:" + eSt + ", requestHeaders:" + rSt);
                    rewiremock_1.default.disable();
                    done();
                }).run();
            });
            var _a;
        });
    });
});
//# sourceMappingURL=test.spec.js.map