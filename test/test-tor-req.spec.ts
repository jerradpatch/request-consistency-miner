
import {TorClientControl, TorRequest} from "tor-request";

var torOptions = {
    "debug": true,
    "password": "LoveMaoMao1234"
};

var url = "http://api.ipify.org"; // this api returns your ip in the respnose body
var tcc = new TorClientControl(torOptions);
var tr = new TorRequest();

describe('test tor-request works correctly', function () {
    this.timeout(15000);
// api.ipify.org returns your ip in the response body
    describe('verify that we have a new tor session (new ip)', function () {
        it('should return without error', function (done) {
            tr.torRequest(url, function (err0, res0, firstIp) {
                if (err0)
                    throw err0;

                if (!firstIp)
                    throw "no ip address was returned on first request";

                tcc.newTorSession()
                    .subscribe((secondIp: string) => {

                        if (!secondIp)
                            throw "no ip address was returned on second request";

                        if (firstIp === secondIp)
                            throw `The public ip was the same as one of the tor ipAddresses; firstTorIp: ${firstIp}, secondTorIp: ${secondIp}`;

                        console.log(`success, The requests, firstTorIp: ${firstIp}, secondTorIp: ${secondIp}`);

                        done();

                    }, (err) => {
                        throw err;
                    });
            });
        });
    });
});