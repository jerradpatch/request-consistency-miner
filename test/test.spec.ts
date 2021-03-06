
import * as mkdirp from 'mkdirp';
import * as fs from 'fs';
import * as Fiber from 'fibers/fibers';
import {Subject, Observable} from 'rxjs/Rx';
import {IRCMOptions_source, IPageCacheObj} from "../index";
import {RequestConsistencyMiner} from '../index'
import rewiremock from 'rewiremock';


//setup mocks
let syncWrite = null;
let asycWrite = null;
let asycContentsRead = false;
let requestHeaders = null;

function mockFs(contents: string) {
  rewiremock('fs')
    .with({
      readFileSync: () => {
        return JSON.parse(contents);
      },
      writeFileSync: (path, data) => {
        syncWrite = data;
      },
      readFile: (a,b,c) => {
        asycContentsRead = true;
        c(null, contents);
      },
      writeFile: (path, data, func) => {
        asycWrite = data;
        func();
      },
      unlink: (path, err) => {
        asycWrite = null;
      }
    });
}

function mockFs_emptyDisk(contents: string) {
  rewiremock('fs')
      .with({
        readFileSync: () => {
          return null;
        },
        writeFileSync: (path, data) => {
          syncWrite = data;
        },
        readFile: (a,b,c) => {
          asycContentsRead = true;
          throw "err";
        },
        writeFile: (path, data, func) => {
          asycWrite = data;
          func();
        },
        unlink: (path, err) => {
          asycWrite = null;
        }
      });
}


function mockTR(ipAddresses: string[], returnedContent?: string) {
  let i = 0;
  rewiremock('tor-request')
      .with({
        TorRequest : () => {
          return {
            get: (uri: any, options: any, callback?: any) => {
              if (callback)
                requestHeaders = options.headers;
                callback(null, {statusCode: 200}, returnedContent || "");
            }
          }
        },
        TorClientControl : () => {
          return {
            newTorSession: (): Observable<string> => {
              i = (i > ipAddresses.length-1 ? ipAddresses.length-1 : i);
              return Observable
                  .of(ipAddresses[i])
                  .delay(100)
                  .do((ip)=>{
                    i++;
                  })
                  .take(1);
            }
          }
        }
      });
}

describe('testing all the different options', function () {
  this.timeout(15000);

  beforeEach( () => {
    syncWrite = null;
    asycWrite = null;
    asycContentsRead = false;
    requestHeaders = null;
  });

  afterEach( () =>{
    rewiremock.disable();
  });

  let fileContents = JSON.stringify({page: "this was read from the file"});

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

  function isPageSuccessful(body: string, url: string, ipAddress: string): string {

    if (body.indexOf("Page view limit exceeded") != -1) {
        console.log(`Databases:common:torRequest: Page view limit exceeded, url: ${url}`);
      return 'backoff';

    } else if(body.indexOf("blacklisted") != -1) {
      console.log(`Databases:common:torRequest: Ip blacklisted because of server abuse`);
      return 'blacklist';

    } else if(body.length < 3000) {
      console.log(`Databases:common:torRequest: page did not meet minimum length, url: ${url}`);
      return 'blacklist';

    }
    // else if(body.indexOf("type='video/mp4'") == -1) {
    //   console.log(`Databases:common:torRequest: no video tag found, url: ${url}`);
    //   return 'blacklist';
    //
    // }
    else {
      console.log(`Databases:common:torRequest: success, url: ${url}`);
      return 'true';
    }
  }

  function randomUserHeaders(oSource: {source: string}) {

    let userAgent = [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 9_1 like Mac OS X) AppleWebKit/601.1 (KHTML, like Gecko) CriOS/61.0.3163.100 Mobile/13B143 Safari/601.1.46',
      'Mozilla/5.0 (iPad; CPU OS 9_1 like Mac OS X) AppleWebKit/601.1 (KHTML, like Gecko) CriOS/61.0.3163.100 Mobile/13B143 Safari/601.1.46',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/61.0.3163.100 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/61.0.3163.100 Safari/537.36',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/61.0.3163.100 Safari/537.36'
    ];

    let random = Math.ceil((Math.random() * 100));

    let headers = {
      'host': oSource.source,
      'Connection': 'keep-alive',
      'Pragma': 'no-cache',
      'Cache-Control': 'no-cache',
      'Upgrade-Insecure-Requests': 1,
      'Accept': '*/*',
      'Accept-Encoding': 'identity',
      'Accept-Language': 'en-US,en;q=0.8',
      'Cookie': 'bw=0; pp=r;',
      'User-Agent': 'curl/7.47.0'
    };

    return headers;
  }


  // describe('storageUrl, storage folder should be set with read and write permissions', function () {
  //   it('should return without error', function (done) {
  //     let rcmOptions = createRcmOptions({
  //       debug: true,
  //       readFromDiskAlways: false,
  //       ipUsageLimit: 20
  //     });
  //
  //     var path = rcmOptions.storagePath;
  //
  //     mkdirp(path, function (err) {
  //       if (err)
  //         throw new Error("couldnt create directory");
  //
  //       fs.access(path, fs.constants.R_OK | fs.constants.W_OK, function(err) {
  //         if(err)
  //           throw new Error("read and write permissions are needed on storagePath");
  //         done();
  //       });
  //     });
  //   });
  // });

  describe('readFromDiskWhenDebug, should read from disk when debug is set true', function () {
    it('should return without error', function (done) {

      let rcmOptions = createRcmOptions({
        debug: true,
        readFromDiskAlways: false,
        ipUsageLimit: 20
      });

      let paramOptions = {
        source:'http://' + sourceUrl + '/',
        diskTimeToLive: 60 * 1000,
        requestHeaders: randomUserHeaders,
        pageResponse: isPageSuccessful
      };

      rewiremock.inScope(() => {
        mockFs(fileContents);
        mockTR([""]);

        rewiremock.enable();

        let RCM = require('../index');
        let rcm = new RCM.RequestConsistencyMiner(rcmOptions, torClientOptions);

        Fiber(() => {
          let page = rcm.torRequest(paramOptions);

          if (!page || page !== JSON.parse(fileContents).page)
            throw new Error(`the file contents did not match the page fetched, pageReturned: ${page}`);

          done();
        }).run();

        rewiremock.disable();
      });

    });
  });

  describe('readFromDiskWhenDebug, should not read from disk when debug is set false', function () {
    it('should return without error', function (done) {

      let rcmOptions = createRcmOptions({
        debug: false,
        readFromDiskAlways: false,
        ipUsageLimit: 20
      });

      let paramOptions = {
        source:'http://' + sourceUrl + '/',
        diskTimeToLive: 60 * 1000,
        requestHeaders: randomUserHeaders,
        pageResponse: isPageSuccessful
      };

      rewiremock.inScope(() => {
        mockFs(fileContents);
        rewiremock.enable();

        let RCM = require('../index');
        let rcm = new RCM.RequestConsistencyMiner(rcmOptions, torClientOptions);

        Fiber(() => {
          let page = rcm.torRequest(paramOptions);

          if (!page || page !== JSON.parse(fileContents).page)
            throw new Error(`the file contents did not match the page fetched, pageReturned: ${page}`);

          done();
        }).run();

        rewiremock.disable();
      });

    });
  });

  describe('source.ipBlackList, should ask for a new IP when function returns "blacklisted" ', function () {
    it('should return without error', function (done) {

      const blacklistedIp = "1.1.1.1";

      let rcmOptions = createRcmOptions({
        debug: false,
        readFromDiskAlways: false,
        ipUsageLimit: 20
      });

      let paramOptions = {
        source:'http://' + sourceUrl + '/',
        requestHeaders: randomUserHeaders,
        pageResponse: (body: string, url: string, ipAddress: string): string =>{
          if(ipAddress === blacklistedIp) {
            return "blacklist";
          } else {
            return 'true';
          }
        }
      };

      rewiremock.inScope(() => {
        mockFs(fileContents);
        //set currentIp
        mockTR([blacklistedIp,"2.2.2.2"]);

        rewiremock.enable();

        let RCM = require('../index');

        Fiber(() => {
          let rcm = new RCM.RequestConsistencyMiner(rcmOptions, torClientOptions);

          //request page
          rcm.torRequest(paramOptions);

          //check that the black list only contains the blacklisted IP
          let blist = rcm.getIpBlackList();
          if (!blist || blist.length != 1 || blist[0] !== blacklistedIp)
            throw new Error(`the black list didn't contain expected, expected:${[blacklistedIp]}, result:${JSON.stringify(blist)}`);

          if (!syncWrite || syncWrite !== JSON.stringify([{"ipAddress":blacklistedIp}]))
            throw new Error(`the ip blacklist was not written to disk, expected:${[{"ipAddress":blacklistedIp}]}, result:${syncWrite}`);

          done();
        }).run();

        rewiremock.disable();
      });

    });
  });

  describe('source.ipUsageLimit, should ask for a new Ip address after resource request limit/backoff reached', function () {
    it('should return without error', function (done) {

      let rcmOptions = createRcmOptions({
        debug: false,
        readFromDiskAlways: false,
        ipUsageLimit: 1
      });

      let paramOptions = {
          source:'http://' + sourceUrl + '/',
          requestHeaders: randomUserHeaders,
          pageResponse: (body: string, url: string, ipAddress: string): string => {
            return 'true';
          }
      }

      rewiremock.inScope(() => {
        mockFs(fileContents);
        //set currentIp
        mockTR(["1.1.1.1", "2.2.2.2"]);//needs a enough new IPs per expected fetch new IP

        rewiremock.enable();

        let RCM = require('../index');

        Fiber(() => {
          let rcm = new RCM.RequestConsistencyMiner(rcmOptions, torClientOptions);

          //request page
          rcm.torRequest(paramOptions);
          rcm.torRequest(paramOptions);

          if (!rcmOptions._currentIpUse || rcmOptions._currentIpUse !== 1) //one on constructor, one for second fet
            throw new Error(`the number of new Ip's requested does not is not 1, rcmOptions._currentIpUse:${rcmOptions._currentIpUse}`);

          done();
        }).run();

        rewiremock.disable();
      });
    });
  });

  describe('source.ipUsageLimit, after usage limit reached it should add ip to backoff list and set a timeout', function () {
    it('should return without error', function (done) {

      let nonBackOffIp = "2.2.2.2";
      let backOffIp = "1.1.1.1";
      let ipBackoffTimeout = 500;

      let rcmOptions = createRcmOptions({
        debug: false,
        readFromDiskAlways: false,
        ipUsageLimit: 1
      });

      let paramOptions = {
        source:'http://' + sourceUrl + '/',
        requestHeaders: randomUserHeaders,
        pageResponse: (body: string, url: string, ipAddress: string): Date| string =>{

          if(ipAddress === backOffIp) {
            return new Date(Date.now() + ipBackoffTimeout);
          } else {
            return 'true';
          }
        }
      };

      rewiremock.inScope(() => {
        mockFs(fileContents);
        //set currentIp
        mockTR([backOffIp, nonBackOffIp]);//needs a enough new IPs per expected fetch new IP

        rewiremock.enable();

        let RCM = require('../index');

        Fiber(() => {
          let rcm = new RCM.RequestConsistencyMiner(rcmOptions, torClientOptions);

          //request page
          rcm.torRequest(paramOptions);

          let backOffIps = rcm.getIpBackoffList();
          if (backOffIps.length !== 1 && backOffIps[0] !== backOffIp) //one on constructor, one for second fet
            throw new Error(`backoff IpAddresses are not the count expected, expected 1, actual=${backOffIps && backOffIps.length}`);

          setTimeout(() => {
            backOffIps = rcm.getIpBackoffList();
            if (backOffIps.length !== 0) //one on constructor, one for second fet
              throw new Error(`backoff IpAddresses are not the count expected, expected 0, actual=${backOffIps && backOffIps.length}`);

            done();
          }, ipBackoffTimeout+100);
        }).run();

        rewiremock.disable();
      });
    });
  });

  describe('source.ipUsageLimit, after usage limit reached and set timeout expires, it should reuse previous IP address', function () {
    it('should return without error', function (done) {
      let firstIp = "1.1.1.1";
      let secondIp = "2.2.2.2";
      let ipBackoffTimeout = 100;

      let requestCount = 0;
      let currentIp = '';

      let rcmOptions = createRcmOptions({
        debug: false,
        readFromDiskAlways: false,
        ipUsageLimit: 100
      });

      let paramOptions = {
        source:'http://' + sourceUrl + '/',
        requestHeaders: randomUserHeaders,
        pageResponse: (body: string, url: string, ipAddress: string): Date| string =>{

          currentIp = ipAddress;

          let ret;
          if(requestCount === 0 || requestCount === 1) {
            ret = new Date(Date.now() + ipBackoffTimeout);
          } else {
            ret =  'true';
          }

          requestCount++;
          return ret;
        }
      }

      rewiremock.inScope(() => {
        mockFs(fileContents);
        //set currentIp
        mockTR([firstIp, secondIp, firstIp]);//needs a enough new IPs per expected fetch new IP

        rewiremock.enable();

        let RCM = require('../index');

        Fiber(() => {
          let rcm = new RCM.RequestConsistencyMiner(rcmOptions, torClientOptions);

          //request page
          //it will backoff first, back off second, keep getting first, until timer, ticks and removes first, then it
          // it will complete and return
          rcm.torRequest(paramOptions);

          if (requestCount !== 3)
            throw new Error(`requestCount, expected:3, actual:${requestCount}`);

          if (currentIp !== firstIp)
            throw new Error(`firstIp, expected:3, actual:${requestCount}`);

          done();
          rewiremock.disable();
        }).run();
      });
    });
  });

  describe('source.diskTimeToLive, after a request is made, the request should be persisted to the disk space with a time to live set', function () {
    it('should return without error', function (done) {

      let rcmOptions = createRcmOptions({
        debug: false,
        readFromDiskAlways: false,
        ipUsageLimit: 100
      });

      let paramOptions = {
          source:'http://' + sourceUrl + '/',
          diskTimeToLive: 1000,
          requestHeaders: randomUserHeaders,
          pageResponse: (body: string, url: string, ipAddress: string): Date| string => {
            return 'true';
          }
      }

      rewiremock.inScope(() => {
        mockFs_emptyDisk(fileContents);
        //set currentIp
        mockTR(["1.1.1.1"]);//needs a enough new IPs per expected fetch new IP

        rewiremock.enable();

        let RCM = require('../index');

        Fiber(() => {
          let rcm = new RCM.RequestConsistencyMiner(rcmOptions, torClientOptions);

          rcm.torRequest(paramOptions);

          //timeout for async event to complete
          setTimeout(()=>{
            let diskObj = JSON.parse(asycWrite);
            if(diskObj.date === 'undefined' || diskObj.page === 'undefined')
              throw new Error(`fileContents, expect:${fileContents}, actual:${asycWrite}`);

            rewiremock.disable();
            done();
          }, 500)
        }).run();
      });
    });
  });

  describe('source.diskTimeToLive, the request should return a different page after the disk time-to-live expired', function () {
    it('should return without error', function (done) {

      let timeoutBeforeDiskCacheCleared = 1000;
      let returnedPageData = "dummy text to be cleared via a write to the disk from 'diskTimeToLive' timeout";

      let rcmOptions = createRcmOptions({
        debug: false,
        readFromDiskAlways: false,
        ipUsageLimit: 100
      });

      let paramOptions = {
        source:'http://' + sourceUrl + '/',
        diskTimeToLive: 1000,
        requestHeaders: randomUserHeaders,
        pageResponse: (body: string, url: string, ipAddress: string): Date| string => {
          return 'true';
        }
      };


      rewiremock.inScope(() => {

        mockFs_emptyDisk(null);
        //set currentIp
        mockTR(["1.1.1.1"], returnedPageData);//needs a enough new IPs per expected fetch new IP

        rewiremock.enable();

        let RCM = require('../index');

        Fiber(() => {
          let rcm = new RCM.RequestConsistencyMiner(rcmOptions, torClientOptions);

          rcm.torRequest(paramOptions);

          setTimeout(() => {
            if (!asycContentsRead)
              throw new Error(`asycContentsRead, the disk should have been attempted to have been read from, expect:true, actual:${asycContentsRead}`);

            if (!asycWrite || JSON.parse(asycWrite).page !== returnedPageData)
              throw new Error(`asycWrite, the disk should have been attempted to have been written to with page data from, expect:${returnedPageData}, actual:${asycWrite}`);

            //disk should contain cached page
            setTimeout(() => {
              if (asycWrite)
                throw new Error(`asycWrite, contents should have been cleared from the disk when the 'diskTimeToLive' expired, expect:null, actual:${asycWrite}`);

              rewiremock.disable();
              done();
            }, timeoutBeforeDiskCacheCleared + 100);
          } ,0);
        }).run();
      });

    });
  });

  describe('source.requestHeaders, a request should be made with the given headers', function () {
    it('should return without error', function (done) {


      let expectedHeaders = randomUserHeaders({source: sourceUrl});

      let rcmOptions = createRcmOptions({
        debug: false,
        readFromDiskAlways: false,
        ipUsageLimit: 100,
      });

      let paramOptions = {
        source:'http://' + sourceUrl + '/',
        requestHeaders: ()=>{
          return expectedHeaders;
        },
        pageResponse: (body: string, url: string, ipAddress: string): Date| string => {
          return 'true';
        }
      };

      rewiremock.inScope(() => {

        mockFs_emptyDisk(null);
        //set currentIp
        mockTR(["1.1.1.1", "2.2.2.2"]);//needs a enough new IPs per expected fetch new IP

        rewiremock.enable();

        let RCM = require('../index');

        Fiber(() => {
          let rcm = new RCM.RequestConsistencyMiner(rcmOptions, torClientOptions);

          rcm.torRequest(paramOptions);

          let eSt =JSON.stringify(expectedHeaders);
          let rSt = JSON.stringify(requestHeaders);

          if(eSt !== rSt)
            throw new Error(`expectedHeaders, the expected headers does not match the expected headers for the http request, expectedHeaders:${eSt}, requestHeaders:${rSt}`);

          rewiremock.disable();
          done();
        }).run();
      });
    });
  });

  describe('torNewSession: all promises (when resolved) should end with same Ip address. The next promise should have different Ip Address', function () {
    it('should return without error', function (done) {

      let rcmOptions = createRcmOptions({
        debug: true,
        readFromDiskAlways: false,
        ipUsageLimit: 100
      });

      Fiber(() => {


        let rcm = new RequestConsistencyMiner(rcmOptions, torClientOptions);

        let reqs = [];

        for(var i = 0; i < 20; ++i) {
          reqs.push(rcm.torNewSession());
        }

        return Promise.all(reqs)
          .then((ips)=>{
            let firstIp = ips.reduce((p,c)=>{
              if(p !== c){
                throw new Error('the first ip array was not completely equal')
              }
              return p;
            });


            reqs = [];

            for(var i = 0; i < 20; ++i) {
              reqs.push(rcm.torNewSession());
            }

            return Promise.all(reqs)
                .then((ips)=>{
                  let secondIp = ips.reduce((p,c)=>{
                    if(p !== c){
                      throw new Error('the second ip array was not completely equal')
                    }
                    return p;
                  });

                  if(firstIp === secondIp)
                    throw new Error(`did not fetch a new Ip, firstIp:${firstIp}, secondIp:${secondIp}`);

                  done();
                });
          });
      }).run();
    })
  });

  describe('torRequest: test that we can fetch an actual webpage', function () {
    it('should return without error', function (done) {
      var rcmOptions = createRcmOptions({
        debug: true,
        readFromDiskAlways: false,
        ipUsageLimit: 100
      });

      Fiber(function () {
        var rcm = new RequestConsistencyMiner(rcmOptions, torClientOptions);

        var obj = {
          source: "http://animeheaven.eu",
          diskTimeToLive: 3600000,
          pageResponse: isPageSuccessful,
          requestHeaders: randomUserHeaders
        };

        var page = rcm.torRequest(obj);

        if(page.length < 10000)
          throw new Error("the correct page was not fetched");

        done();
      }).run();
    });
  });
});
