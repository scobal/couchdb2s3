#!/usr/bin/env node

var util = require('util');
var fs = require('fs');
var url = require('url');
var crypto = require('crypto');
var knox = require('knox');
var Henry = require('henry');
var Step = require('step');
var request = require('request');
var carrier = require('carrier');
var Queue = require('basic-queue');
var argv = require('optimist')
    .config(['config', 'jobflows'])
    .usage('Export CouchDB Database to s3\n' +
           'Usage: $0 [options]'
    )
    .demand(['outputBucket', 'database'])
    .argv;
var s3Client;

process.title = 'couchdb2s3';

var henry = new Henry({
    api: argv.awsMetadataEndpoint
}).on('refresh', function(credentials) {
    util.log('Henry refresh: ' + credentials.key);
});

var dbUrl = url.parse(argv.database);
var dbName = dbUrl.pathname.split('/')[1];
var dbClient;

var tempFilepath = '/tmp/couchdb2s3-'+ dbName +'-'+ (new Date()).getTime();

var rand = crypto.createHash('md5')
    .update(crypto.randomBytes(256))
    .digest('base64')
    .replace(/[^a-zA-Z0-9]/g,'');

var pad = function(n) {
    var prefix = function(v, l) {
        while (v.length < l) { v = '0' + v; }
        return v;
    };
    var len = 2;
    var s = n.toString();
    return s.length == len ? s : prefix(s, len);
};

var d = new Date();
var s3Key = util.format('/db/%s-%s-%s-%s-%s-%s', dbName, d.getUTCFullYear(),
    pad(d.getUTCMonth() + 1), pad(d.getUTCDate()), pad(d.getUTCHours()), rand);

Step(function() {
    s3Client = knox.createClient({
        // Cannot pass null or empty key/secret to knox constructor
        // 'x' is just filler and Henry will update it.
        key: argv.awsKey || 'x',
        secret: argv.awsSecret || 'x',
        bucket: argv.outputBucket,
        region: argv.awsRegion
    });
    henry.add(s3Client, function(err) {
        if (err && ['ETIMEDOUT', 'EHOSTUNREACH', 'ECONNREFUSED']
            .indexOf(err.code) === -1) return this(err);
        this(null);
    }.bind(this));
}, function(err) {
    if (err) throw err;
    var uri = url.format({
        protocol: dbUrl.protocol,
        host: dbUrl.host,
        pathname: dbUrl.pathname + "/_all_docs",
        query: {include_docs:"true"}
    });

    var next = this;
    var errorCount = 0;
    var q = new Queue(function(lines, cb) {
        fs.appendFile(tempFilepath, lines, 'utf8', cb);
    }, 1);

    var auth = dbUrl.auth;
    if (auth) {
        auth = dbUrl.auth.split(':');
        auth = { user: auth[0], pass: auth[1] };
    }
    request({uri: uri, auth: auth})
       .on('error', function() { throw new Error("Could not connect to CouchDB"); })
       .on('response', function(res) {
           if (res.statusCode != 200) throw new Error("Bad response from CouchDB");
           // Buffer writes for better speed, thanks to fewer disk writes.
           var linebuf = [];
           carrier.carry(res, function(line) {
               try {
                   line = JSON.parse(line.replace(/(,$)/, ""));
                   line = JSON.stringify(line.doc) + "\n";
                   linebuf.push(line);

                   if (linebuf.length > 50000)  {
                       q.add(linebuf.join(''));
                       linebuf = [];
                   }
               }
               catch(e) {
                   errorCount++;
               }
            }).on('end', function() {
                var done = function() {
                    // Error count should be exactly 2.
                    if (errorCount == 2) {
                        return fs.appendFile(tempFilepath, linebuf.join(''), 'utf8', next);
                    }
                    next(new Error("Failed to parse database"));
                }
                if (q.running) q.on('empty', done);
                else done();
            });
        });
}, function(err) {
    if (err) throw err;
    var next = this;
    var tries = 3;
    var put = function() {
        s3Client.putFile(tempFilepath, s3Key, {
            'x-amz-server-side-encryption':'AES256'
        }, function(err, res) {
            if (!err) return next(null, res);
            else if (tries > 0) {
                console.log('Upload to s3 failed, trying again.');
                tries--;
                return put();
            }
            return next(err);
        });
    };
    put();

}, function(err, res) {
    if (err) throw err;
    if (!res) throw new Error('upload failed');
    if (res.statusCode !== 200) throw new Error('s3 returned ' + res.statusCode);

    fs.unlink(tempFilepath, this);
}, function(err) {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    henry.stop();
    console.log('%s : Uploaded %s database to %s', (new Date()), argv.database, s3Key);
});
