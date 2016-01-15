'use strict';

const cluster = require('cluster');
const fs = require('fs');
const express = require('express');
const DubAPI = require('dubapi');
const Youtube = require('youtube-api');
const config = require('./config');

Youtube.authenticate({
    type: 'key',
    key: config.googleApiKey
});

if (cluster.isMaster) {
    var botsCount = config.profiles.length;
    var workers = new Map();
    for (let i = 0; i < botsCount; ++i) {
        const worker = cluster.fork();
        workers.set(config.profiles[i].credentials.username, worker);
        worker.on('online', () => {
            worker.send({
                type: 'profile-index',
                data: i
            });
        });
    }
    cluster.on('exit', (worker) => {
        console.log(`worker ${worker.process.pid} died`);
    });
    setupApi(workers);
} else {
    var dubapi;
    process.on('message', (msg) => {
        if (msg.type == 'profile-index') {
            startBot(config.profiles[msg.data], (client) => {
                dubapi = client;
            });
        } else if (dubapi) {
            if (msg.type == 'pause') {
                pause(dubapi);
            } else if (msg.type == 'unpause') {
                unpause(dubapi);
            } else if (msg.type == 'say') {
                say(dubapi, msg.data);
            }
        }
    });
}

function setupApi (workers) {
    var app = express();
    app.use((req, res, next) => {
        if (req.query.pw == config.apiPassword) {
            next();
        } else {
            res.status(401).send('Wrong password!');
        }
    });
    app.get('/pause', (req, res) => {
        workers.get(req.query.bot).send({type: 'pause'});
        res.sendStatus(200);
    });
    app.get('/unpause', (req, res) => {
        workers.get(req.query.bot).send({type: 'unpause'});
        res.sendStatus(200);
    });
    app.get('/say', (req, res) => {
        workers.get(req.query.bot).send({
            type: 'say',
            data: req.query.msg
        });
        res.sendStatus(200);
    });
    app.listen(
        process.env.OPENSHIFT_NODEJS_PORT || 8080,
        process.env.OPENSHIFT_NODEJS_IP || '127.0.0.1'
    );
}

function startBot (profile, callback) {
    new DubAPI({
        username: profile.credentials.username,
        password: profile.credentials.password
    }, (err, dubapi) => {
        if (err) return console.error(err);
        dubapi.connect(config.room);
        dubapi.on('error', console.error);
        dubapi.on('disconnected', () => {
            setTimeout(() => dubapi.connect(config.room), 10000);
        });
        dubapi.on('connected', () => {
            unpause(dubapi, () => {
                setInterval(() => {
                    getQueueItems(dubapi, (data) => {
                        if (data.length < 10) {
                            getPlaylistItems(profile.playlists.randomItem(), (data) => {
                                queueSong(dubapi, data.randomItem(), 'youtube');
                            });
                        }
                    });
                }, 60000);
            });
        });
        dubapi.on(dubapi.events.roomPlaylistUpdate, function (data) {
            if (data.startTime != -1) return;
            if (Math.random() * 10 > 5) {
                setTimeout(() => dubapi.updub(), 30000 * Math.random());
            }
        });
        callback(dubapi);
    });
}

function setQueuePausedState (dubapi, state, callback) {
    var endpoint = `room/${dubapi._.room.id}/queue/pause`;
    var formData = {queuePaused: state};
    dubapi._.reqHandler.queue({method: 'PUT', url: endpoint, form: formData}, (code, body) => {
        if (body && body.data && body.data.err) {
            console.error(code + ': ' + body.data.err);
        } else if (callback) {
            callback();
        }
    });
}

const pause = (dubapi, callback) => setQueuePausedState(dubapi, 1, callback);
const unpause = (dubapi, callback) => setQueuePausedState(dubapi, 0, callback);

function say (dubapi, message) {
    dubapi.sendChat(message);
}

function queueSong (dubapi, id, type, callback) {
    var endpoint = `room/${dubapi._.room.id}/playlist`;
    var formData = {songId: id, songType: type};
    dubapi._.reqHandler.queue({method: 'POST', url: endpoint, form: formData}, (code, body) => {
        if (body && body.data && body.data.err) {
            console.error(code + ': ' + body.data.err);
        } else if (callback) {
            callback();
        }
    });
}

function getQueueItems (dubapi, callback) {
    var endpoint = `user/session/room/${dubapi._.room.id}/queue`;
    dubapi._.reqHandler.queue({method: 'GET', url: endpoint}, (code, body) => {
        if (body && body.data && body.data.err) {
            console.error(code + ': ' + body.data.err);
        } else {
            callback(body.data);
        }
    });
}

function getPlaylistItems (playlistId, callback) {
    fs.readFile('cache/' + playlistId, (err, data) => {
        if (err && err.code == 'ENOENT') {
            var results = [];
            var recurse = (pageToken) => {
                Youtube.playlistItems.list({
                    playlistId: playlistId,
                    part: 'contentDetails',
                    pageToken: pageToken
                }, (err, data) => {
                    if (err) return console.error(err);
                    results = results.concat(
                        data.items.map(item =>
                            item.contentDetails.videoId));
                    if (data.nextPageToken) {
                        recurse(data.nextPageToken);
                    } else {
                        fs.writeFile('cache/' + playlistId, JSON.stringify(results), (err) => {
                            if (err) console.error(err);
                            callback(results);
                        });
                    }
                });
            };
            recurse();
        } else if (err) {
            console.error(err);
        } else {
            callback(JSON.parse(data));
        }
    });
}

Array.prototype.randomItem = function () {
    return this[Math.floor(this.length * Math.random())];
};