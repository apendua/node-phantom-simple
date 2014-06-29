"use strict";

var http            = require('http');
var spawn 			= require('child_process').spawn;
var exec            = require('child_process').exec;
var util            = require('util');

var POLL_INTERVAL   = process.env.POLL_INTERVAL || 500;

function getRandomPort () {
  return Math.ceil(Math.random() * 20000) + 10000;
};

var queue = function (worker) {
    var _q = [];
    var running = false;
    var q = {
        push: function (obj) {
            _q.push(obj);
            q.process();
        },
        process: function () {
            if (running || _q.length === 0) return;
            running = true;
            var cb = function () {
                running = false;
                q.process();
            }
            var task = _q.shift();
            worker(task, cb);
        }
    }
    return q;
}

function callbackOrDummy (callback) {
    return callback || function () {};
}

function processCallback (r, phantom, pages, setup_new_page) {
    if (r.page_id) {
        if (pages[r.page_id] && r.callback === 'onPageCreated') {
            var new_page = setup_new_page(r.args[0]);
            if (pages[r.page_id].onPageCreated) {
                pages[r.page_id].onPageCreated(new_page);
            }
        }
        else if (pages[r.page_id] && pages[r.page_id][r.callback]) {
            var callbackFunc = pages[r.page_id][r.callback];
            if (callbackFunc.length > 1) {
                // We use `apply` if the function is expecting multiple args
                callbackFunc.apply(pages[r.page_id], wrapArray(r.args));
            }
            else {
                // Old `call` behaviour is deprecated
                callbackFunc.call(pages[r.page_id], unwrapArray(r.args));
            }
        }
    }
    else {
        var cb = callbackOrDummy(phantom[r.callback]);
        cb.apply(phantom, r.args);
    }
}

function unwrapArray (arr) {
    return arr && arr.length == 1 ? arr[0] : arr
}

function wrapArray(arr) {
    // Ensure that arr is an Array
    return (arr instanceof Array) ? arr : [arr];
}

exports.create = function (callback, options) {
    var port = getRandomPort();

    if (options === undefined) options = {};
    if (options.phantomPath === undefined) options.phantomPath = 'phantomjs';
    if (options.parameters === undefined) options.parameters = {};

    function spawnPhantom (callback) {
        var args=[];
        for(var parm in options.parameters) {
            args.push('--' + parm + '=' + options.parameters[parm]);
        }
        args = args.concat([__dirname + '/bridge.js', port]);

        var phantom = spawn(options.phantomPath, args);

        // Ensure that the child process is closed when this process dies
        var closeChild = function () {
            try {
                phantom.kill();
            } catch(e) {}
            process.exit(1);
        };

        var uncaughtHandler = function (err) {
            console.error(err.stack);
            closeChild();
        };

        // Note it's possible to blow up maxEventListeners doing this - consider moving to a single handler.
        ['SIGINT', 'SIGTERM'].forEach(function(sig) {
            process.on(sig, closeChild);
        });

        process.on('uncaughtException', uncaughtHandler);

        phantom.once('error', function (err) {
        	callback(err);
        });

        phantom.stderr.on('data', function (data) {
            if (options.ignoreErrorPattern && options.ignoreErrorPattern.exec(data)) {
                return;
            }
            return console.warn('phantom stderr: '+data);
        });
        var exitCode = 0;
        phantom.once('exit', function (code) {
            ['SIGINT', 'SIGTERM'].forEach(function(sig) {
                process.removeListener(sig, closeChild);
            });
            process.removeListener('uncaughtException', uncaughtHandler);
            exitCode = code;
        });

        // Wait for "Ready" line
        phantom.stdout.once('data', function (data) {
            var matches = data.toString().match(/Ready \[(\d+)\]/);
            if (!matches) {
                phantom.kill();
                return callback("Unexpected output from PhantomJS: " + data);
            }
           
            callback(null, phantom, port);
        });

        setTimeout(function () {    //wait a bit to see if the spawning of phantomjs immediately fails due to bad path or similar
        	if (exitCode !== 0) {
        		return callback("Phantom immediately exited with: " + exitCode);
        	}
        },100);
    };
    
    spawnPhantom(function (err, phantom, port) {
        if (err) {
            return callback(err);
        }

        // console.log("Phantom spawned with web server on port: " + port);

        var pages = {};

        var setup_new_page = function (id) {
            // console.log("Page created with id: " + id);
            var methods = [
                'addCookie', 'childFramesCount', 'childFramesName', 'clearCookies', 'close',
                'currentFrameName', 'deleteCookie', 'evaluateJavaScript',
                'evaluateAsync', 'getPage', 'go', 'goBack', 'goForward', 'includeJs',
                'injectJs', 'open', 'openUrl', 'release', 'reload', 'render', 'renderBase64',
                'sendEvent', 'setContent', 'stop', 'switchToFocusedFrame', 'switchToFrame',
                'switchToFrame', 'switchToChildFrame', 'switchToChildFrame', 'switchToMainFrame',
                'switchToParentFrame', 'uploadFile',
            ];
            var page = {
                setFn: function (name, fn, cb) {
                    request_queue.push([[id, 'setFunction', name, fn.toString()], callbackOrDummy(cb)]);
                },
                get: function (name, cb) {
                    request_queue.push([[id, 'getProperty', name], callbackOrDummy(cb)]);
                },
                set: function (name, val, cb) {
                    request_queue.push([[id, 'setProperty', name, val], callbackOrDummy(cb)]);
                },
                evaluate: function (fn, cb) {
                    var extra_args = [];
                    if (arguments.length > 2) {
                        extra_args = Array.prototype.slice.call(arguments, 2);
                        // console.log("Extra args: " + extra_args);
                    }
                    request_queue.push([[id, 'evaluate', fn.toString()].concat(extra_args), callbackOrDummy(cb)]);
                },
                waitForSelector: function (selector, cb, timeout) {
                    var startTime = Date.now();
                    var timeoutInterval = 150;
                    var testRunning = false;
                    //if evaluate succeeds, invokes callback w/ true, if timeout,
                    // invokes w/ false, otherwise just exits
                    var testForSelector = function () {
                        var elapsedTime = Date.now() - startTime;

                        if (elapsedTime > timeout) {
                            return cb("Timeout waiting for selector: " + selector);
                        }

                        page.evaluate(function (selector) {
                            return document.querySelectorAll(selector).length;
                        }, function (result) {
                            testRunning = false;
                            if (result > 0) {//selector found
                                cb();
                            }
                            else {
                                setTimeout(testForSelector, timeoutInterval);
                            }
                        }, selector);
                    };

                    timeout = timeout || 10000; //default timeout is 10 sec;
                    setTimeout(testForSelector, timeoutInterval);
                },
            };
            methods.forEach(function (method) {
                page[method] = function () {
                    var all_args = Array.prototype.slice.call(arguments);
                    var callback = null;
                    if (all_args.length > 0 && typeof all_args[all_args.length - 1] === 'function') {
                        callback = all_args.pop();
                    }
                    var req_params = [id, method];
                    request_queue.push([req_params.concat(all_args), callbackOrDummy(callback)]);
                }
            });

            pages[id] = page;

            return page;            
        }

        var request_queue = queue(function (paramarr, next) {
            var params = paramarr[0];
            var callback = paramarr[1];
            var page = params[0];
            var method = params[1];
            var args = params.slice(2);
            
            var http_opts = {
                hostname: '127.0.0.1',
                port: port,
                path: '/',
                method: 'POST',
            }

            phantom.POSTING = true;

            var req = http.request(http_opts, function (res) {
                // console.log("Got a response: " + res.statusCode);
                var err = res.statusCode == 500 ? true : false;
                res.setEncoding('utf8');
                var data = '';
                res.on('data', function (chunk) {
                    data += chunk;
                });
                res.on('end', function () {
                    phantom.POSTING = false;
                    if (!data) {
                        next();
                        return callback("No response body for page." + method + "()");
                    }
                    var results = JSON.parse(data);
                    // console.log("Response: ", results);
                    
                    if (err) {
                        next();
                        return callback(results);
                    }

                    if (method === 'createPage') {
                        var id = results.page_id;
                        var page = setup_new_page(id);
                        
                        next();
                        return callback(null, page);
                    }

                    // Not createPage - just run the callback
                    next();
                    callback(null, results);
                });
            });

            req.on('error', function (err) {
                console.warn("Request() error evaluating " + method + "() call: " + err);
                next();
            })

            req.setHeader('Content-Type', 'application/json');

            var json = JSON.stringify({page: page, method: method, args: args});
            // console.log("Sending: ", json);
            req.setHeader('Content-Length', Buffer.byteLength(json));
            req.write(json);
            req.end();
        });

        // callback listener
        phantom.stdout.on('data', function (data) {
            var lines = data.toString().split('\n');
            lines.forEach(function (line) {
                var match = /^JSON\s*(.*)/.exec(line);
                if (match) { // this is probably a callback
                    try {
                        processCallback(JSON.parse(match[1]), phantom, pages, setup_new_page);
                    } catch (err) {} // ignore errors
                } else if (line) { // ignore empty lines
                    console.log('phantom stdout: ' + line);
                }
            });
        });

        var proxy = {
            process: phantom,
            createPage: function (callback) {
                request_queue.push([[0,'createPage'], callbackOrDummy(callback)]);
            },
            injectJs: function (filename,callback) {
                request_queue.push([[0,'injectJs', filename], callbackOrDummy(callback)]);
            },
            addCookie: function (cookie, callback) {
                request_queue.push([[0,'addCookie', cookie], callbackOrDummy(callback)]);
            },
            clearCookies: function (callback) {
                request_queue.push([[0, 'clearCookies'], callbackOrDummy(callback)]);
            },
            deleteCookie: function (cookie, callback) {
                request_queue.push([[0, 'deleteCookie', cookie], callbackOrDummy(callback)]);
            },
            set : function (property, value, callback) {
                request_queue.push([[0, 'setProperty', property, value], callbackOrDummy(callback)]);
            },
            get : function (property, callback) {
                request_queue.push([[0, 'getProperty', property], callbackOrDummy(callback)]);
            },
            exit: function(callback){
                phantom.kill('SIGTERM');
                callbackOrDummy(callback)();
            },
            on: function () {
                phantom.on.apply(phantom, arguments);
            },
        };
        
        callback(null, proxy);
    });
}

