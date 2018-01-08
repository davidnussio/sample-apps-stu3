const request   = require("request");
const jwt       = require("jsonwebtoken");
const crypto    = require("crypto");
const fs        = require("fs");
const base64url = require("base64-url");
const config    = require("./config.json");
const lib       = require("./lib");
require("colors");


// The (last known) access token is stored in this global variable. When it
// expires the code should re-authenticate and update it.
let ACCESS_TOKEN;

// You can set this env var to "/dev/null"
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || `${__dirname}/downloads`;

function downloadFhir() {
    
    if (!ACCESS_TOKEN) {
        return authorize().then(downloadFhir);
    }

    return lib.requestPromise({
        url: config.fhir_url + "/Patient/$everything",
        method: "GET",
        headers: {
            Authorization: "Bearer " + ACCESS_TOKEN,
            Accept       : "application/fhir+ndjson",
            Prefer       : "respond-async"
        }
    })
    .then(
        res => {
            console.log("Waiting for the server to generate the files...".green);
            return waitForFiles(res.headers["content-location"]);
        }
    )
    .then(downloadFile)
    .catch(err => {
        console.error(`Download failed: ${err}`.red);
        process.exit(1);
    });
}

function waitForFiles(url, timeToWait = 0) {
    return lib.requestPromise({ url }, timeToWait).then(res => {

        // Still working?
        if (res.statusCode == 202) {
            let pct = res.headers["x-progress"];
            if (pct) {
                process.stdout.write(lib.generateProgress(pct));
                return waitForFiles(url, 1000);
            }
        }

        // Files generated
        else if (res.statusCode == 200) {
            process.stdout.write(lib.generateProgress(100));
            console.log(``);
            return res.headers.link.split(/\s*,\s*/)
                .map(f => f.replace(/^\s*<\s*/, "").replace(/\s*>\s*$/, ""));
        }

        // Any other status is considered an error
        // This includes the "204 No Content" case!
        return Promise.reject(res.statusCode + ": " + res.statusMessage);
    });
}

function downloadFile(files) {
    if (files.length) {
        let url = files.shift();

        return new Promise((resolve, reject) => {
            let fileName = url.split("/").pop(), n = 0;
            process.stdout.write(`Downloading file ${fileName}: ... `);

            lib.requestPromise({ url }).then(res => {
                if (DOWNLOAD_DIR && DOWNLOAD_DIR != "/dev/null") {
                    fs.writeFile(
                        `${DOWNLOAD_DIR}/${fileName}`,
                        res.body,
                        error => {
                            if (error) {
                                return reject(error)
                            }
                            resolve()
                        }
                    )
                } else {
                    resolve()
                }
            }, reject);
        }).then(() => {
            process.stdout.write(`Done!\n`.green);
            return downloadFile(files)
        }, err => {
            process.stdout.write(`FAILED!\n`.red);
            console.log(String(err).red);
        });
    }

    console.log(`\nAll files downloaded`.green);
    return true;
}

/**
 * Authorizes the app and resolves the promise with the access token response
 * @returns {Promise<Object>}
 */
function authorize() {

    console.log(ACCESS_TOKEN === null ? "Re-authorizing..." : "Authorizing...");

    let jwtToken = {
        iss: config.service_url,
        sub: config.client_id,
        aud: config.token_url,
        exp: Date.now()/1000 + 300, // 5 min
        jti: crypto.randomBytes(32).toString("hex")
    };

    return lib.requestPromise({
        method: "POST",
        url   : config.token_url,
        json  : true,
        form  : {
            scope: "system/*.*",
            grant_type: "client_credentials",
            client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
            client_assertion: jwt.sign(
                jwtToken,
                base64url.decode(config.private_key),
                { algorithm: 'RS256'}
            )
        }
    }).then(res => {
        ACCESS_TOKEN = res.body.access_token;
        return res.body;
    }).catch(err => {
        console.error(`Authorization failed: ${err}`.red);
        process.exit(1);
    });
}


// RUN! ------------------------------------------------------------------------
downloadFhir().catch(err => {
    
    // Check if this is an expired token error
    if (String(err).search(/expired/i) > -1) {
        
        // If so, clear the local token to trigger re-authorization
        ACCESS_TOKEN = null;

        // and then try again
        return downloadFhir();
    }
    
    console.error(String(err).red);
});