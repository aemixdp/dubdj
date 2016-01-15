'use strict';

const cluster = require('cluster');
const fs = require('fs');
const DubAPI = require('dubapi');
const Youtube = require('youtube-api');
const config = require('./config');

Youtube.authenticate({
    type: 'key',
    key: config.googleApiKey
});

if (cluster.isMaster) {
    var botsCount = config.profiles.length;
    for (let i = 0; i < botsCount; ++i) {
        const worker = cluster.fork();
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
} else {
    process.on('message', (msg) => {
        if (msg.type == 'profile-index') {
            start(config.profiles[msg.data]);
        }
    });
}

function start (profile) {
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
    });
}

function unpause (dubapi, callback) {
    var endpoint = `room/${dubapi._.room.id}/queue/pause`;
    var formData = {queuePaused: 0};
    dubapi._.reqHandler.queue({method: 'PUT', url: endpoint, form: formData}, (code, body) => {
        if (body && body.data && body.data.err) {
            console.error(code + ': ' + body.data.err);
        } else if (callback) {
            callback();
        }
    });
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