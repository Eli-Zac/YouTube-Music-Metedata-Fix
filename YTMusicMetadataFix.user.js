// ==UserScript==
// @name         YouTube Music Metadata Fix
// @namespace    https://github.com/Eli-Zac/YouTube-Music-Metedata-Fix
// @version      1.0.3
// @description  Ensures full track metadata (title, artist, album) is correctly set in MediaSession and Web Scrobbler for YouTube Music.
// @author       Eli_Zac
// @icon         https://www.google.com/s2/favicons?sz=64&domain=music.youtube.com
// @match        https://music.youtube.com/*
// @run-at       document-start
// @license      MIT
// @updateURL    https://github.com/Eli-Zac/YouTube-Music-Metedata-Fix/raw/refs/heads/main/YTMusicMetadataFix.user.js
// @downloadURL  https://github.com/Eli-Zac/YouTube-Music-Metedata-Fix/raw/refs/heads/main/YTMusicMetadataFix.user.js
// ==/UserScript==

(function () {
    'use strict';

    // Track state
    let lastTrackId = null;
    let lastVideoSrc = null;
    let isFirstTrack = true;
    let isOurUpdate = false;
    const DEBUG = false;

    function log(...args) {
        if (DEBUG) console.log('[YTM Metadata Fix]', ...args);
    }

    /**
     * Extract metadata from the player bar DOM elements
     */
    function getMetadataFromPlayer() {
        const titleEl = document.querySelector('.title.ytmusic-player-bar');
        const byline = document.querySelector('.byline.ytmusic-player-bar');
        if (!titleEl || !byline) return null;

        const title = titleEl.textContent.trim();
        
        // Parse byline text using bullet separator (•) instead of link order
        // Format is typically: "Artist • Album • Year" or "Artist • Album"
        const bylineText = byline.textContent.trim();
        const parts = bylineText.split('•').map(p => p.trim());
        
        const artist = parts[0] || ''; // First part is always the artist
        const album = parts[1] || '';  // Second part is the album

        return { title, artist, album };
    }

    /**
     * Dispatch multiple events to signal track change to Web Scrobbler
     */
    function dispatchWebScrobblerEvents(videoElement) {
        if (!videoElement) return;

        // Dispatch multiple events to ensure Web Scrobbler picks up the change
        const events = ['timeupdate', 'play', 'seeked'];
        events.forEach(eventName => {
            try {
                videoElement.dispatchEvent(new Event(eventName, { bubbles: true }));
                log(`Dispatched ${eventName} event`);
            } catch (e) {
                console.error(`Error dispatching ${eventName}:`, e);
            }
        });
    }

    /**
     * Update MediaSession metadata and notify Web Scrobbler
     */
    function pushMetadataToMediaSessionAndScrobbler(reason = 'unknown') {
        if (!navigator.mediaSession) return;

        const data = getMetadataFromPlayer();
        if (!data) {
            log('No metadata available in player');
            return;
        }

        const trackId = `${data.title}::${data.artist}::${data.album}`;
        const isNewTrack = trackId !== lastTrackId;

        if (!isNewTrack && !isFirstTrack && reason !== 'periodical') {
            return; // Skip if same track and not periodic check
        }

        lastTrackId = trackId;

        log(`Track changed (${reason}): ${data.title} - ${data.artist}`, {
            isFirstTrack,
            isNewTrack,
            data
        });

        // Update MediaSession text fields in-place, never touch artwork
        const existing = navigator.mediaSession.metadata;
        if (existing) {
            existing.title = data.title;
            existing.artist = data.artist;
            existing.album = data.album;
            // Re-assign to trigger browser update, skip our patch
            isOurUpdate = true;
            navigator.mediaSession.metadata = existing;
            isOurUpdate = false;
        }

        // Dispatch events to notify Web Scrobbler
        const videoElement = document.querySelector('video');
        if (videoElement) {
            dispatchWebScrobblerEvents(videoElement);
        }

        if (isFirstTrack) {
            isFirstTrack = false;
            log('First track detected and synced');
        }
    }

    /**
     * Patch the mediaSession.metadata setter to inject correct metadata
     */
    function patchMediaSessionSetter() {
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
                    if (isOurUpdate) {
                        // Our own re-assignment — pass through immediately
                        descriptor.set.call(this, value);
                        return;
                    }
                    // YouTube Music's update — fix text fields, leave artwork alone
                    // Use setTimeout instead of requestAnimationFrame to work even when tab is not focused
                    setTimeout(() => {
                        const data = getMetadataFromPlayer();
                        if (data && value) {
                            value.title = data.title;
                            value.artist = data.artist;
                            value.album = data.album;
                            log('Patched mediaSession metadata:', data);
                        }
                        descriptor.set.call(this, value);
                    }, 0);
                } catch (e) {
                    console.error('MediaSession patch error:', e);
                }
            }
        });

        log('MediaSession setter patched');
    }

    /**
     * Observe changes in the player bar (title, artist, album text changes)
     */
    function observePlayerBarChanges() {
        const playerBar = document.querySelector('ytmusic-player-bar');
        if (!playerBar) {
            log('Player bar not found');
            return false;
        }

        const observer = new MutationObserver(() => {
            pushMetadataToMediaSessionAndScrobbler('playerBarMutation');
        });

        observer.observe(playerBar, {
            childList: true,
            subtree: true,
            characterData: true
        });

        log('Player bar change observer started');
        return true;
    }

    /**
     * Observe video element src changes (detects manual skips)
     */
    function observeVideoSourceChanges() {
        const videoElement = document.querySelector('video');
        if (!videoElement) {
            log('Video element not found');
            return false;
        }

        // Initial video src
        lastVideoSrc = videoElement.src;

        const observer = new MutationObserver(() => {
            const currentSrc = videoElement.src;
            if (currentSrc && currentSrc !== lastVideoSrc) {
                lastVideoSrc = currentSrc;
                log('Video source changed (detected manual skip)');
                // Wait longer for artwork to load after skip (300ms instead of 100ms)
                setTimeout(() => {
                    pushMetadataToMediaSessionAndScrobbler('manualSkip');
                }, 300);
            }
        });

        observer.observe(videoElement, {
            attributes: true,
            attributeFilter: ['src']
        });

        log('Video source change observer started');
        return true;
    }

    /**
     * Initialize the script when mediaSession is available
     */
    function initializeScript() {
        if (!navigator.mediaSession) {
            log('MediaSession not available, retrying...');
            setTimeout(initializeScript, 100);
            return;
        }

        log('=== YouTube Music Metadata Fix v2.0.0 Initialized ===');

        // Patch the mediaSession setter
        patchMediaSessionSetter();

        // Set up observers
        const playerBarObserverStarted = observePlayerBarChanges();
        const videoObserverStarted = observeVideoSourceChanges();

        // Initial metadata sync (detects first track)
        setTimeout(() => {
            pushMetadataToMediaSessionAndScrobbler('pageLoad');
        }, 500);

        // Periodic fallback sync every 2 seconds to catch missed events
        setInterval(() => {
            pushMetadataToMediaSessionAndScrobbler('periodical');
        }, 2000);

        log('Observers and intervals initialized. Monitoring metadata changes...');
    }

    // Start initialization
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initializeScript);
    } else {
        // DOM already loaded
        initializeScript();
    }

})();