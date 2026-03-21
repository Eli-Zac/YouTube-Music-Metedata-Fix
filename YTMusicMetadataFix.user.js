// ==UserScript==
// @name         YouTube Music Metadata Fix
// @namespace    https://github.com/Eli-Zac/YouTube-Music-Metadata-Fix
// @version      1.6
// @description  Ensures full track metadata (title, artist, album) is correctly set in MediaSession and Web Scrobbler for YouTube Music.
// @author       Eli_Zac
// @icon         https://www.google.com/s2/favicons?sz=64&domain=music.youtube.com
// @match        https://music.youtube.com/*
// @run-at       document-start
// @license      MIT
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

    function debounce(fn, delay) {
        let timer;
        return function (...args) {
            clearTimeout(timer);
            timer = setTimeout(() => fn.apply(this, args), delay);
        };
    }

    /**
     * Extract only the primary artist from a potentially multi-artist string
     */
    function extractPrimaryArtist(artistText) {
        if (!artistText) return '';

        const separators = /\s+(?:&|,|feat\.?|ft\.?|featuring|x)\s+/i;
        return artistText.split(separators)[0].trim();
    }

    /**
     * Extract metadata from the player bar DOM elements
     */
    function getMetadataFromPlayer() {
        const titleEl = document.querySelector('.title.ytmusic-player-bar');
        const byline = document.querySelector('.byline.ytmusic-player-bar');
        if (!titleEl || !byline) return null;

        const title = titleEl.textContent.trim();

        // Use anchor hrefs to reliably distinguish artists from albums:
        //   - Artist links point to  channel/...  (each separate artist gets its own <a>)
        //   - Album  links point to  browse/...
        // A band name like "Angus & Julia Stone" is ONE <a> tag, so we get the full name.
        // Separate artists like "Kendrick Lamar & SZA" are TWO <a> tags; we take only the first.
        let artist = '';
        let album = '';

        const links = byline.querySelectorAll('a');
        for (const link of links) {
            const href = link.getAttribute('href') || '';
            if (!artist && href.includes('channel/')) {
                artist = link.textContent.trim();
            } else if (!album && href.includes('browse/')) {
                album = link.textContent.trim();
            }
        }

        // Fallback to text parsing if DOM links are unavailable (e.g. video mode)
        if (!artist) {
            const bylineText = byline.textContent.trim();
            const parts = bylineText.split('•').map(p => p.trim());
            const engagementPatterns = /^[\d.]+[KMB]?\s*(Views?|Likes?|Comments?|Shares?)$/i;
            const metadataParts = parts.filter(part => !engagementPatterns.test(part));
            artist = extractPrimaryArtist(metadataParts[0] || '');
            album = album || metadataParts[1] || '';
        }

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

        // Dispatch events to notify Web Scrobbler only on actual track changes,
        // not on periodical syncs where nothing changed (avoids spurious play events)
        const videoElement = document.querySelector('video');
        if (videoElement && isNewTrack) {
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
                        } else {
                            // DOM unavailable — pass value through untouched.
                            // We cannot safely split artist names without the DOM
                            // (e.g. "Angus & Julia Stone" is one artist, not two).
                            log('DOM unavailable, passing mediaSession value through unchanged');
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

        const observer = new MutationObserver(debounce(() => {
            pushMetadataToMediaSessionAndScrobbler('playerBarMutation');
        }, 150));

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

        log('=== YouTube Music Metadata Fix Initialized ===');

        // Patch the mediaSession setter
        patchMediaSessionSetter();

        // Set up observers — retry every 500ms if elements aren't in the DOM yet
        (function startObservers(barDone, vidDone) {
            if (!barDone) barDone = observePlayerBarChanges();
            if (!vidDone) vidDone = observeVideoSourceChanges();
            if (!barDone || !vidDone) {
                setTimeout(() => startObservers(barDone, vidDone), 500);
            }
        })(false, false);

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
