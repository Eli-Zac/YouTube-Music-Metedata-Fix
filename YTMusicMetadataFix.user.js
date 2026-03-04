// ==UserScript==
// @name         YouTube Music Metedata Fix
// @namespace    https://github.com/Eli-Zac/YouTube-Music-Metedata-Fix
// @version      1.0.0
// @description  Ensures full track metadata (title, artist, album) is correctly set in MediaSession for YouTube Music, keeping Windows controls and Web Scrobbler in sync.
// @author       Eli_Zac
// @match        https://music.youtube.com/*
// @run-at       document-start
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    function getMetadataFromPlayer() {
        const titleEl = document.querySelector('.title.ytmusic-player-bar');
        const byline = document.querySelector('.byline.ytmusic-player-bar');
        if (!titleEl || !byline) return null;

        const title = titleEl.textContent.trim();
        const links = byline.querySelectorAll('a');
        const artist = links[0]?.textContent.trim() || '';
        const album = links[1]?.textContent.trim() || '';

        return { title, artist, album };
    }

    function patchMediaSession() {
        if (!navigator.mediaSession) return;
        const proto = Object.getPrototypeOf(navigator.mediaSession);
        const descriptor = Object.getOwnPropertyDescriptor(proto, 'metadata');
        if (!descriptor || !descriptor.set) return;

        Object.defineProperty(navigator.mediaSession, 'metadata', {
            configurable: true,
            enumerable: true,
            get: descriptor.get.bind(navigator.mediaSession),
            set: function (value) {
                try {
                    requestAnimationFrame(() => {
                        const data = getMetadataFromPlayer();
                        if (data) {
                            value.title = data.title;
                            value.artist = data.artist;
                            value.album = data.album;
                        }
                        descriptor.set.call(this, value);
                    });
                } catch (e) {
                    console.error('MediaSession override error', e);
                }
            }
        });
    }

    const wait = setInterval(() => {
        if (navigator.mediaSession) {
            clearInterval(wait);
            patchMediaSession();
        }
    }, 50);

})();
