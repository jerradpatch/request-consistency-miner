WIP 

TODO: when different calls to same page have different cache times, give a warning and set to lowest page cache time.

# Request-Consistency-Miner
- This makes a request, for the purpose of data mining, consistant given remote server anti-mining tactics. We use tor exit nodes for proxying requests.

## Concepts used:
Tor, NodeJs, Typescript, RxJs

## anti-tactics we handle / Features Provided:
-- Ip Blacklisting per source
-- Ip usage limit/back off per source
-- Resource request reduction
-- Set headers per source + auto Randomize userAgent header


### Definitions:
black listing - black listed an Ip that was used to make a request, we will never use that IP again.
Black listing is attempted to be prevented by using Ip usage limits. 

Ip usage limits/back off - uWhere a timelimit is set on an IP address before it can be used again.

Resource request reduction - cache the requested URL's to a set time limit, serving the originally fetched page until that time limit expires.                          

Configuration Object:

```javascript
{
  "torClient": {
    "debug": true,
    "options": {
      "password": "LoveMaoMao1234",
      "host": "localhost",
      "controlPort": 9051,
      "socksPort": 9050,
      "type": 5
    }
  },
  rcmOptions : {
      "storagePath": <string>,
      "debug"?: <boolean>,
      "readFromDiskAlways"?: <boolean>,
       [source:string] : {
        "ipBlackList"?: Function(page: string): boolean,
        "ipUsageLimit"?: <number>,
        "diskTimeToLive"?: <number>
        "requestHeaders"?: Function(): Object
      }
  } : IRCMOptions
}
```
